import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import {
  collectSecrets, harnessOutputSchema, isTrustedLocation, omitOptionalNulls, redactJson, redactText, resolveTrustedExecutable, runProcessGroup, structuredOutputValidator,
  validateHarnessPayload, validateHarnessProfile,
  type CommandResult, type CommandRunner, type HarnessCapabilities, type HarnessOutput, type HarnessProfile, type JsonValue, type NormalizedRunEvent,
  type PanelHarnessAdapter, type PreflightDiagnostic, type PreflightResult, type ReviewFnConfig, type SlotHarnessInput, type SlotHarnessOutput,
  type SlotObservation, type SlotRunLimitation,
} from "@superfunctions/reviewfn-core";

export type { CommandResult, CommandRunner, HarnessProfile } from "@superfunctions/reviewfn-core";

/** The adapter contract version a run configuration (`harness.version`) or `harnessContractVersions.cli` names. */
export const CLI_HARNESS_CONTRACT_VERSION = "1";
/** Arguments that print the CLI's version when a profile sets no `versionArgv`. */
export const CLI_DEFAULT_VERSION_ARGV: readonly string[] = Object.freeze(["--version"]);
const VERSION_TIMEOUT_MS = 10_000;
const VERSION_OUTPUT_BYTES = 64_000;
/** Normalized events retained per run, across both attempts. */
const MAX_EVENTS = 1_000;
/** Retention limits on stored strings; they bound only what is stored, after redaction, never what is checked. */
const MAX_DETAIL_CHARS = 4_000;
const MAX_MODEL_CHARS = 256;
/** Bytes of the rejected answer echoed back in the repair prompt. */
const REPAIR_ECHO_BYTES = 16_384;
const DIRECTORY_REPLACED = "The CLI's attempt directory was replaced.";
/** How often a running CLI's output file is measured against the remaining output budget. */
const OUTPUT_FILE_POLL_MS = 100;
/** Levels of JSON string escaping a secret is still recognized under; each level is decoded in linear time. */
const MAX_ESCAPE_DEPTH = 8;
/** How long a `stderr-regex` model reporter may match, in a worker that is terminated when it runs over or the run is canceled. */
const MODEL_REPORT_TIMEOUT_MS = 2_000;
/**
 * How long a reporter still runs once the run is aborted (canceled, or stopped at the panel's deadline), so a report it
 * has already matched is returned well within the panel's abort grace.
 */
const MODEL_REPORT_ABORT_GRACE_MS = 50;
const ENV_NAME = /^[A-Z_a-z]\w*$/;
const QUOTA = /quota|rate.?limit|usage.?limit|credit balance|too many requests/i;

const isDigit = (char: string | undefined): boolean => char !== undefined && char >= "0" && char <= "9";
const isAlphanumeric = (char: string | undefined): boolean => char !== undefined && /^[0-9A-Za-z]$/.test(char);
/** A character that may not adjoin a version token: a word character or a dot. */
const joinsToken = (char: string | undefined): boolean => char !== undefined && (char === "." || /^\w$/.test(char));
/** A character of a pre-release or build suffix; `+` starts build metadata after a pre-release (`1.2.3-rc.1+build.7`). */
const isSuffixCharacter = (char: string | undefined): boolean => char === "-" || char === "+" || char === "." || isAlphanumeric(char);
/** A `-` or `+` that follows a letter or digit: a suffix may end just before one. */
const isSuffixBreak = (text: string, index: number): boolean => (text[index] === "-" || text[index] === "+") && isAlphanumeric(text[index - 1]);

function digitsEnd(text: string, index: number): number {
  let end = index;
  while (isDigit(text[end])) end += 1;
  return end;
}

/**
 * Where a pre-release or build suffix starting at each position can end, computed in one pass from the right so the
 * whole scan stays linear: the end of the run of suffix characters, and the last `-` or `+` in that run that follows a
 * letter or digit (a suffix may also end just before one).
 */
function suffixTable(text: string): { runEnd: Int32Array; lastDash: Int32Array } {
  const runEnd = new Int32Array(text.length + 1).fill(text.length);
  const lastDash = new Int32Array(text.length + 1).fill(-1);
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (!isSuffixCharacter(text[index])) { runEnd[index] = index; continue; }
    runEnd[index] = runEnd[index + 1];
    const dash = isSuffixBreak(text, index) ? index : -1;
    lastDash[index] = lastDash[index + 1] === -1 ? dash : lastDash[index + 1];
  }
  return { runEnd, lastDash };
}

/** The end of the longest suffix from `from` that ends in a letter or digit and adjoins no word character or dot. */
function suffixEnd(text: string, table: ReturnType<typeof suffixTable>, from: number): number | undefined {
  if (!isSuffixCharacter(text[from])) return undefined;
  const end = table.runEnd[from];
  if (isAlphanumeric(text[end - 1]) && !joinsToken(text[end])) return end;
  return table.lastDash[from] === -1 ? undefined : table.lastDash[from];
}

/** The version token starting at `start` (an optional `v`, two or more dotted numbers, an optional suffix), or undefined. */
function versionAt(text: string, table: ReturnType<typeof suffixTable>, start: number): string | undefined {
  const first = text[start] === "v" ? start + 1 : start;
  let end = digitsEnd(text, first);
  if (end === first) return undefined;
  let parts = 1;
  while (text[end] === "." && isDigit(text[end + 1])) { end = digitsEnd(text, end + 1); parts += 1; }
  if (parts < 2) return undefined;
  const suffix = text[end] === "-" || text[end] === "+" ? suffixEnd(text, table, end + 1) : undefined;
  if (suffix !== undefined) return text.slice(first, suffix);
  return joinsToken(text[end]) ? undefined : text.slice(first, end);
}

/** The first version token of `text`, whole, read by a linear scan rather than a backtracking pattern. */
function firstVersion(text: string): string | undefined {
  const table = suffixTable(text);
  for (let index = 0; index < text.length; index += 1) {
    if (index > 0 && joinsToken(text[index - 1])) continue;
    const version = versionAt(text, table, index);
    if (version !== undefined) return version;
  }
  return undefined;
}

/**
 * The version a CLI's version output reports: the first dotted version token of stdout, else of stderr. A token has an
 * optional `v` prefix and pre-release and build suffixes (`v1.2.3`, `2025.08.25-896bbe1`, `1.2.3-rc.1+build.7`) and
 * adjoins no word character or dot.
 */
export function parseCliVersion(stdout: string, stderr = ""): string | undefined {
  return firstVersion(stdout) ?? firstVersion(stderr);
}

/** Values of the closed placeholder set for one attempt. */
export interface CliPlaceholderValues { promptFile: string; schemaFile: string; outputFile: string; workspace: string; model: string }

/**
 * A profile's argv with each whole-argument placeholder replaced by its value, as exactly one argument. Text that merely
 * contains a placeholder is never substituted (the policy rejects such profiles), and nothing is ever split or quoted.
 */
export function cliArguments(argv: readonly string[], values: CliPlaceholderValues): string[] {
  const table: Record<string, string> = { "{promptFile}": values.promptFile, "{schemaFile}": values.schemaFile, "{outputFile}": values.outputFile, "{workspace}": values.workspace, "{model}": values.model };
  return argv.map(argument => Object.hasOwn(table, argument) ? table[argument] : argument);
}

/** The last line of `stdout` that parses as a JSON object, or undefined when none does. Progress lines before it are ignored. */
export function lastJsonObjectLine(stdout: string): Record<string, unknown> | undefined {
  return lastJsonObject(stdout)?.value;
}

function lastJsonObject(stdout: string): { value: Record<string, unknown>; line: string } | undefined {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) return { value, line };
    } catch { /* not JSON: keep looking */ }
  }
  return undefined;
}

/** The value at a dotted path of own properties (`a.b.0`), or undefined. */
export function valueAtPath(value: unknown, dotted: string): unknown {
  let current: unknown = value;
  for (const key of dotted.split(".")) {
    if (Array.isArray(current) && /^\d+$/.test(key)) current = current[Number(key)];
    else if (isRecord(current) && Object.hasOwn(current, key)) current = current[key];
    else return undefined;
  }
  return current;
}

/**
 * The CLI's environment: exactly the profile's allowlisted names that are set, plus the slot's `credentialEnv`. Nothing
 * else is inherited, not even PATH or HOME unless the profile lists them.
 */
export function cliEnvironment(source: NodeJS.ProcessEnv, allowlist: readonly string[], credentialEnv?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [...allowlist, ...(credentialEnv ? [credentialEnv] : [])]) if (ENV_NAME.test(name) && source[name] !== undefined) environment[name] = source[name];
  return environment;
}

export interface CliHarnessOptions {
  /** The executable when neither the slot nor the run configuration names one. */
  executable?: string;
  runner?: CommandRunner;
  environment?: NodeJS.ProcessEnv;
}

/**
 * Generic agent-CLI adapter. It runs any CLI that reads a prompt (stdin or a file) and writes one JSON object (a file
 * or the last JSON line of stdout), as a trusted panel profile declares: argv placeholders are whole arguments of a
 * direct spawn (no shell), the environment is the profile's allowlist, the output is validated against the slot's
 * output schema with one bounded repair attempt, and a configured model reporter voids a run that served another model.
 * It enforces no tool restriction of its own (`toolControls: false`): a `tree-verified-only` profile reports that only
 * the unchanged checkout was verified.
 */
export class CliHarnessAdapter implements PanelHarnessAdapter {
  public readonly capabilities: HarnessCapabilities = {
    id: "cli",
    version: CLI_HARNESS_CONTRACT_VERSION,
    providers: [],
    authModes: [],
    structuredOutput: false,
    observableEvents: false,
    usageMetrics: false,
    cancellation: true,
    toolControls: false,
    sandboxModes: ["enforced-read-only", "tree-verified-only"],
  };
  private readonly runner: CommandRunner;
  private readonly executable: string | undefined;
  private readonly environment: NodeJS.ProcessEnv;
  /**
   * Versions observed by a probe, by the exact invocation that reported them: the executable's path and file identity,
   * the version arguments and the probe's environment. A pin is satisfied only by an observation of the invocation that
   * serves the slot, never by another profile's environment or by an executable since replaced at the same path.
   */
  private readonly versions = new Map<string, string>();

  public constructor(options: CliHarnessOptions = {}) {
    this.runner = options.runner ?? runProcessGroup;
    this.executable = options.executable;
    this.environment = options.environment ?? process.env;
  }

  public async preflight(config: ReviewFnConfig, signal?: AbortSignal): Promise<PreflightResult> {
    const diagnostics = this.configurationDiagnostics(config);
    const profile = config.harness.profileDefinition;
    let version: string | undefined;
    if (profile && diagnostics.every(item => item.level !== "error")) {
      if (profile.capabilities.sandbox === "tree-verified-only") diagnostics.push({ code: "REVIEWFN_HARNESS_SANDBOX_UNENFORCED", level: "warning", message: `Profile ${String(config.harness.profile)} enforces no tool restriction: only the unchanged checkout is verified. Host-level sandboxing of generic CLI harnesses is not provided.` });
      if (profile.modelReport === "none") diagnostics.push({ code: "REVIEWFN_HARNESS_MODEL_UNVERIFIED", level: "warning", message: `Profile ${String(config.harness.profile)} reports no model: its runs record model_unverified, and runs of one executable and profile count as one identity.` });
      const environment = cliEnvironment(this.environment, profile.envAllowlist, config.inference.credentialEnv);
      const secrets = this.secrets(config, environment);
      try {
        const executable = await this.resolveExecutable(config);
        const key = await this.versionKey(executable, profile, environment);
        const probed = await this.probeVersion(executable, key, profile, environment, secrets, VERSION_TIMEOUT_MS, signal);
        if ("error" in probed) diagnostics.push({ code: "REVIEWFN_HARNESS_VERSION", level: "error", message: redact(probed.error, secrets) });
        else version = probed.version;
      } catch (error) {
        diagnostics.push({ code: "REVIEWFN_CLI_UNAVAILABLE", level: "error", message: redact(`The CLI executable is unavailable: ${message(error)}`, secrets) });
      }
    }
    const ok = diagnostics.every(item => item.level !== "error");
    return { ok, resolved: ok && version ? { provider: config.inference.provider, model: config.inference.model, auth: config.inference.auth, harnessVersion: version } : undefined, diagnostics };
  }

  public async run(input: SlotHarnessInput): Promise<SlotHarnessOutput> {
    const prepared = this.prepare(input);
    if ("terminal" in prepared) return prepared;
    const { state, profile } = prepared;
    let executable: string;
    let key: string;
    try {
      executable = await this.resolveExecutable(input.configuration, input.workspace);
      key = await this.versionKey(executable, profile, prepared.environment);
    } catch (error) { return state.finish("failed", `The CLI executable is unavailable: ${message(error)}`); }
    const unconfirmed = await this.confirmVersion(prepared, executable, key);
    if (unconfirmed) return unconfirmed;
    state.harnessVersion = this.versions.get(key);
    // The slot's pin is checked here, on a cold or a warm cache, so a CLI of another version never runs the review.
    const pinned = input.slot?.harness.version;
    if (pinned !== undefined && state.harnessVersion !== pinned) return state.finish("failed", `The CLI reported version ${String(state.harnessVersion)}, not the pinned ${pinned}, so the review was not run.`);
    let directory: string | undefined;
    let created: string | undefined;
    const identities = new Map<string, string>();
    try {
      directory = await mkdtemp(path.join(tmpdir(), "reviewfn-cli-"));
      created = await identity(directory);
      identities.set(directory, created);
      return await this.attempts({ ...prepared, executable, key, directory, identities });
    } finally {
      // Removed from inside itself (DIRECTORY_HELPER), entering only the attempt directories the adapter created; anything
      // that took the place of one, a link or not, is left alone. The removal is awaited only while the run has time
      // left, so a result already decided is never held past the deadline or a cancellation by it.
      if (directory !== undefined && created !== undefined) {
        const removal = inDirectory(directory, { op: "remove", expect: created, name: path.basename(directory), attempts: [...identities.values()] }).catch(() => undefined);
        const ended = AbortSignal.any([AbortSignal.timeout(Math.max(0, prepared.deadline - Date.now())), ...(input.signal ? [input.signal] : [])]);
        if (!ended.aborted) await Promise.race([removal, new Promise(resolve => ended.addEventListener("abort", resolve, { once: true }))]);
      }
    }
  }

  /** Everything a run needs before a process starts, or the failure that refuses it. */
  private prepare(input: SlotHarnessInput): Prepared | SlotHarnessOutput {
    const config = input.configuration;
    if (input.change.pullRequest !== undefined) return failure("failed", "The generic CLI harness serves only trusted local reviews: pull-request review is refused because it enforces no tool restriction of its own.");
    const refused = this.configurationDiagnostics(config).find(item => item.level === "error");
    if (refused) return failure("failed", refused.message);
    if (!path.isAbsolute(input.workspace)) return failure("failed", "The review workspace must be an absolute path.");
    const profile = config.harness.profileDefinition!;
    let validate: (value: unknown) => string[];
    try { validate = input.outputSchema ? structuredOutputValidator(input.outputSchema) : validateHarnessPayload; }
    catch (error) { return failure("failed", `outputSchema is not a valid JSON Schema: ${message(error)}`); }
    const environment = cliEnvironment(this.environment, profile.envAllowlist, config.inference.credentialEnv);
    const secrets = this.secrets(config, environment);
    const state = new RunState(config.inference.model, profile, secrets, input.policy.limits.maxOutputBytes);
    return { input, profile, schema: input.outputSchema ?? harnessOutputSchema, validate, environment, secrets, state, deadline: Date.now() + input.policy.limits.harnessTimeoutMs };
  }

  /** On a cold version cache, read the version first: a probe that hangs or overruns its output bound ends timed_out. */
  private async confirmVersion(run: Prepared, executable: string, key: string): Promise<SlotHarnessOutput | undefined> {
    if (this.versions.has(key)) return undefined;
    const timeoutMs = Math.max(1, Math.min(VERSION_TIMEOUT_MS, run.deadline - Date.now()));
    const probed = await this.probeVersion(executable, key, run.profile, run.environment, run.secrets, timeoutMs, run.input.signal);
    if (run.input.signal?.aborted) return run.state.finish("canceled", "The CLI run was canceled while its version was read.");
    if (!("error" in probed)) return undefined;
    return run.state.finish(probed.timedOut ? "timed_out" : "failed", probed.error);
  }

  /** The first attempt and, when its answer is rejected, the one repair attempt. */
  private async attempts(prepared: Omit<AttemptContext, "schemaText">): Promise<SlotHarnessOutput> {
    const { state, input, profile } = prepared;
    // The CLI is shown (in the prompt and {schemaFile}) a schema that also declares its json-path model report, so a CLI
    // that enforces the schema can still emit it; its answer is validated against the slot's own schema as written, and
    // only without that field where the slot's schema closes an object to it.
    const cliSchema = withModelReportField(prepared.schema, profile.modelReport);
    const basePrompt = `${input.prompt}\n\n${outputContract(cliSchema, profile)}`;
    const run: AttemptContext = { ...prepared, schemaText: JSON.stringify(cliSchema) };
    // Every promptVia × outputVia combination allows the re-run: each attempt is a new process with a new prompt (on
    // stdin or a new prompt file), its own schema file and a fresh output (a new output file or its own stdout).
    let prompt = basePrompt;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const outcome = await this.attempt(run, attempt, prompt);
      if (!("errors" in outcome)) return outcome;
      state.push("warning", { attempt, message: "The CLI output did not match the output schema." });
      if (attempt === 2) return state.finish("malformed", `The CLI output did not match the output schema after one repair attempt: ${outcome.errors.slice(0, 20).join("; ")}`);
      prompt = repairPrompt(basePrompt, outcome.errors, outcome.rejected, run.secrets);
    }
    return state.finish("malformed", "The CLI produced no structured output.");
  }

  /** One CLI process: its terminal outcome, or the rejection that earns the repair attempt. */
  private async attempt(run: AttemptContext, attempt: number, prompt: string): Promise<SlotHarnessOutput | Rejection> {
    const { state, input, profile } = run;
    const before = attempt === 1 ? "before the CLI started" : "before the repair attempt";
    const outputBytes = state.remainingOutputBytes();
    if (outputBytes <= 0) return state.finish("timed_out", `The CLI output used its whole byte budget ${before}.`);
    // Each attempt gets its own directory, created exclusively with an unpredictable name once the previous attempt has
    // ended, holding its schema, its prompt (written only when the CLI is given its path) and its output path, which is
    // therefore absent when it starts. Nothing an earlier attempt left (a link, a rewritten schema, a planted answer) is
    // ever followed, shown to or read for a later one.
    let made: Awaited<ReturnType<typeof attemptFiles>>;
    try { made = await attemptFiles(run, attempt, prompt); }
    catch (error) { return lapsed(run, before) ?? state.finish("failed", `The CLI attempt's files could not be created: ${message(error)}`); }
    const { helper, ...files } = made;
    const { outputFile } = files;
    // Just before the spawn (Node cannot exec an open file), the executable must still be the one whose version was read,
    // in directories that are still the adapter's; the deadline is read after that and the file writes, so neither can
    // extend it.
    const refused = await this.refusal(run, path.dirname(outputFile), before, `The CLI executable changed after its version was read, so it was refused ${before}.`);
    const remaining = run.deadline - Date.now();
    if (refused || remaining <= 0) { helper.close(); return refused ?? state.finish("timed_out", `The CLI exceeded its configured bound ${before}.`); }
    const args = cliArguments(profile.argv, { ...files, workspace: input.workspace, model: input.configuration.inference.model });
    state.push("started", { attempt, promptVia: profile.promptVia, outputVia: profile.outputVia, sandbox: profile.capabilities.sandbox });
    // The output file, whatever outputVia is (a profile may pass {outputFile} with stdout-last-json), is measured while the
    // CLI runs, together with the stdout and stderr bytes the runner reports: once they outgrow the remaining budget between
    // them the run is aborted, which kills the whole process group, and it ends timed_out like any other overrun.
    const watch = watchOutputFile(outputFile, outputBytes, input.signal);
    // A stderr reporter's worker starts with the CLI, so a report is matched as soon as the CLI stops.
    const reporter = profile.modelReport.startsWith("stderr-regex:") ? startReporter(profile.modelReport.slice("stderr-regex:".length), input.configuration.inference.model) : undefined;
    try {
      let result: CommandResult;
      try { result = await this.runner(run.executable, args, { cwd: input.workspace, env: run.environment, timeoutMs: remaining, maxOutputBytes: outputBytes, signal: watch.signal, onOutput: watch.onOutput, stdin: profile.promptVia === "stdin" ? prompt : "" }); }
      catch (error) { return state.finish(input.signal?.aborted ? "canceled" : "failed", `The CLI could not be started: ${message(error)}`); }
      finally { watch.stop(); }
      // A measurement still in flight when the CLI ended is settled before the answer is judged.
      await watch.settle();
      state.record(result);
      // Every model report is read from what this attempt left, within the output budget, before any terminal return:
      // a run that served another model is void whether it then completed, failed, hung or overran its bounds.
      const unreported = reporter ? await reportStderrModel(run, reporter, result.stderr) : undefined;
      if (unreported) return unreported;
      const outcome = await this.judge(run, attempt, outputFile, result, watch.overrun(), helper);
      state.chargeMeasured(watch.peak());
      return outcome;
    } finally {
      reporter?.dispose();
      helper.close();
    }
  }

  /** The attempt's outcome once its process ended: its answer read, then its terminal outcome or the answer judged. */
  private async judge(run: AttemptContext, attempt: number, outputFile: string, result: CommandResult, fileOverrun: string | undefined, helper: DirectoryHelper): Promise<SlotHarnessOutput | Rejection> {
    // An answer is read only from the directories the adapter created, never through a link that replaced one.
    let replaced = !await intact(run, path.dirname(outputFile));
    const output = replaced ? { error: DIRECTORY_REPLACED } : await readAnswer(run, outputFile, result.stdout, helper);
    replaced ||= "error" in output && output.error === DIRECTORY_REPLACED;
    const terminal = lapsed(run, "before its answer was judged") ?? terminalOutcome(run, attempt, result, output, fileOverrun);
    if (terminal) return terminal;
    // After cancellation and every overrun, before an answer is accepted or repaired: the deadline must not have passed,
    // and the executable and directories must be unchanged.
    const refused = await this.refusal(run, path.dirname(outputFile), "before its answer was accepted", "The CLI executable changed while the attempt ran, so its answer was refused.", replaced);
    return refused ?? accept(run, attempt, output);
  }

  /**
   * After the executable's identity and the attempt's directories are read, in one precedence: the caller's cancellation,
   * then the elapsed deadline (timed_out), then a changed executable, then a replaced run or attempt directory.
   */
  private async refusal(run: AttemptContext, attemptDirectory: string, when: string, changedText: string, replaced = false): Promise<SlotHarnessOutput | undefined> {
    // The directories are read first, so the executable's identity is the last read before a spawn.
    const moved = replaced || !await intact(run, attemptDirectory);
    const changed = await this.changed(run);
    const ended = lapsed(run, when);
    if (ended || changed) return ended ?? run.state.finish("failed", changedText);
    return moved ? run.state.finish("failed", `The CLI's run or attempt directory was replaced, so the attempt was refused ${when}.`) : undefined;
  }

  /** Configuration errors that refuse both preflight and run before any process starts. */
  private configurationDiagnostics(config: ReviewFnConfig): PreflightDiagnostic[] {
    const diagnostics: PreflightDiagnostic[] = [];
    const error = (code: string, text: string) => diagnostics.push({ code, level: "error", message: text });
    if (config.harness.adapter !== this.capabilities.id) error("REVIEWFN_HARNESS_MISMATCH", `Configured harness ${config.harness.adapter} does not match cli.`);
    if (config.harness.version !== CLI_HARNESS_CONTRACT_VERSION) error("REVIEWFN_HARNESS_VERSION", `Only cli adapter contract version ${CLI_HARNESS_CONTRACT_VERSION} is supported.`);
    profileDiagnostics(config, error);
    if (!(config.harness.executable ?? this.executable)) error("REVIEWFN_CLI_EXECUTABLE_REQUIRED", "The cli harness needs an executable: set the slot's harness.executable.");
    const credential = config.inference.credentialEnv;
    if (credential !== undefined && !ENV_NAME.test(credential)) error("REVIEWFN_CREDENTIAL_INVALID", "credentialEnv must name an environment variable.");
    else if (credential && !this.environment[credential]) error("REVIEWFN_CREDENTIAL_MISSING", `credentialEnv ${credential} is not populated.`);
    return diagnostics;
  }

  /**
   * The canonical executable: an absolute path as configured, or a bare name found on the adapter's PATH in a trusted
   * directory. A relative path is refused, because it would resolve inside the repository under review. Either form is
   * resolved through every link and refused when it lands in the working directory or the review workspace, in a
   * directory with a world-writable or Git-repository ancestor (the rule bare names follow), or is a world-writable file,
   * so no repository and no other user can supply the CLI that runs with the credentials.
   */
  private async resolveExecutable(config: ReviewFnConfig, workspace?: string): Promise<string> {
    const configured = config.harness.executable ?? this.executable ?? "";
    if (!path.isAbsolute(configured) && /[\\/]/.test(configured)) throw new Error("harness.executable must be an absolute path or a bare command name, never a relative path.");
    const executable = await realpath(path.isAbsolute(configured) ? configured : await resolveTrustedExecutable(configured, this.environment.PATH ?? ""));
    for (const root of [process.cwd(), ...(workspace === undefined ? [] : [workspace])]) {
      const canonical = await realpath(root);
      if (executable === canonical || executable.startsWith(`${canonical}${path.sep}`)) throw new Error(`harness.executable resolves to ${executable}, inside the repository under review, which may not supply the CLI.`);
    }
    if (!await isTrustedLocation(path.dirname(executable))) throw new Error(`harness.executable resolves to ${executable}, in a directory with a world-writable or Git-repository ancestor, which may not supply the CLI.`);
    const file = await stat(executable);
    const windows = process.platform === "win32";
    if (!file.isFile() || !windows && (file.mode & 0o002) !== 0) throw new Error(`harness.executable resolves to ${executable}, which is not a regular file that only trusted users can change.`);
    await access(executable, windows ? constants.F_OK : constants.X_OK);
    return executable;
  }

  /**
   * The invocation a version observation belongs to: the canonical executable with its file identity (device, inode, size,
   * modification and change times), the version arguments and the probe's whole environment, hashed so no environment
   * value is kept in the key.
   */
  private async changed(run: AttemptContext): Promise<boolean> {
    return await this.versionKey(run.executable, run.profile, run.environment).catch(() => undefined) !== run.key;
  }

  private async versionKey(executable: string, profile: HarnessProfile, environment: NodeJS.ProcessEnv): Promise<string> {
    const file = await stat(executable, { bigint: true });
    const identity = [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].map(String);
    const variables = Object.entries(environment).filter(([, value]) => value !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return createHash("sha256").update(JSON.stringify([executable, identity, profile.versionArgv ?? CLI_DEFAULT_VERSION_ARGV, variables])).digest("hex");
  }

  /**
   * Run the version arguments outside the workspace with the profile's environment and record the reported version. A
   * failure's detail is redacted before it is cut to length, so a secret that crosses the cut cannot leak its prefix. A
   * probe that hangs or overruns its output bound says so, so the run can end timed_out.
   */
  private async probeVersion(executable: string, key: string, profile: HarnessProfile, environment: NodeJS.ProcessEnv, secrets: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ version: string } | { error: string; timedOut: boolean }> {
    const args = [...(profile.versionArgv ?? CLI_DEFAULT_VERSION_ARGV)];
    let result: CommandResult;
    try { result = await this.runner(executable, args, { cwd: tmpdir(), env: environment, timeoutMs, maxOutputBytes: VERSION_OUTPUT_BYTES, signal }); }
    catch (error) { return { error: redact(`The CLI version could not be read: ${message(error)}`, secrets), timedOut: false }; }
    if (result.timedOut) return { error: `The CLI version command exceeded its ${timeoutMs} ms or ${VERSION_OUTPUT_BYTES}-byte bound.`, timedOut: true };
    if (result.code !== 0) return { error: `The CLI version command exited with ${String(result.code ?? result.signal)}: ${redact(result.stderr, secrets).trim().slice(0, 500)}`, timedOut: false };
    const version = parseCliVersion(result.stdout, result.stderr);
    if (!version) return { error: "The CLI reported no recognizable version, so the slot's pinned version cannot be confirmed.", timedOut: false };
    this.versions.set(key, version);
    return { version };
  }

  private secrets(config: ReviewFnConfig, environment: NodeJS.ProcessEnv): string[] {
    const credential = config.inference.credentialEnv ? this.environment[config.inference.credentialEnv] : undefined;
    // The credential, whatever its length (core drops values under 4 characters), and every allowlisted value whose name
    // marks it as a secret.
    return [...new Set([...(credential ? [credential] : []), ...collectSecrets(environment)])];
  }
}

interface Prepared {
  input: SlotHarnessInput;
  profile: HarnessProfile;
  schema: Readonly<Record<string, unknown>>;
  validate: (value: unknown) => string[];
  environment: NodeJS.ProcessEnv;
  secrets: string[];
  state: RunState;
  deadline: number;
}

/** `identities` holds the device and inode of the run directory and each attempt's, as the adapter created them. */
interface AttemptContext extends Prepared { executable: string; key: string; directory: string; identities: Map<string, string>; schemaText: string }

/** After an awaited check: the caller's cancellation, then the elapsed deadline (timed_out), or undefined. */
function lapsed(run: Prepared, when: string): SlotHarnessOutput | undefined {
  if (run.input.signal?.aborted) return run.state.finish("canceled", "The CLI run was canceled.");
  return Date.now() >= run.deadline ? run.state.finish("timed_out", `The CLI exceeded its configured bound ${when}.`) : undefined;
}

/** A directory's device and inode, read without following a link; anything but a directory is refused. */
async function identity(directory: string): Promise<string> {
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory()) throw new Error(`${directory} is not a directory`);
  return `${info.dev}:${info.ino}`;
}

/** Whether the run directory and, when given, the attempt's are still the ones the adapter created. */
async function intact(run: AttemptContext, attemptDirectory?: string): Promise<boolean> {
  for (const directory of [run.directory, ...(attemptDirectory === undefined ? [] : [attemptDirectory])]) {
    if (await identity(directory).catch(() => undefined) !== run.identities.get(directory)) return false;
  }
  return true;
}

/**
 * A new directory for one attempt, created exclusively inside the run directory itself, with its schema and prompt files,
 * by the attempt's helper, which stays in it to read the answer (the caller closes it).
 */
async function attemptFiles(run: AttemptContext, attempt: number, prompt: string): Promise<{ promptFile: string; schemaFile: string; outputFile: string; helper: DirectoryHelper }> {
  if (!await intact(run)) throw new Error("the run directory was replaced");
  const files = [["schema.json", run.schemaText], ...(run.profile.promptVia === "file" || run.profile.argv.includes("{promptFile}") ? [["prompt.md", prompt]] : [])];
  const helper = directoryHelper(run.directory);
  const made = await helper.request({ op: "attempt", expect: run.identities.get(run.directory), prefix: `attempt-${attempt}-`, files }, Math.max(1, run.deadline - Date.now()), run.input.signal);
  if (typeof made.error === "string") { helper.close(); throw new Error(made.error === "EREPLACED" ? "the run or attempt directory was replaced" : made.error); }
  const directory = path.join(run.directory, String(made.name));
  run.identities.set(directory, String(made.identity));
  return { promptFile: path.join(directory, "prompt.md"), schemaFile: path.join(directory, "schema.json"), outputFile: path.join(directory, "output.json"), helper };
}

/**
 * The adapter's operations on its own directories, in a Node process whose working directory, bound to the directory
 * itself (Node has no openat), must have the recorded dev/ino; every name resolves from it, so a path swapped for a link
 * after a check is never followed. It serves one JSON request per stdin line, in order. A new attempt directory is
 * refused, before anything is written to it, unless the name just created is the directory entered, a child of the run
 * directory, and empty; it is then the helper's working directory, from which `read` takes the answer only while the
 * attempt's name is still that directory. `remove` enters only the run directory's recorded attempt directories (and
 * everything inside them), removes a name only while it is the directory just read, and stops at the first mismatch.
 */
const DIRECTORY_HELPER = String.raw`
const fs = require("node:fs");
const id = name => { const found = fs.lstatSync(name, { bigint: true }); return found.dev + ":" + found.ino; };
const fail = () => { throw Object.assign(new Error("replaced"), { code: "EREPLACED" }); };
const wipe = (self, only) => {
  for (const name of fs.readdirSync(".")) {
    const entry = fs.lstatSync(name, { bigint: true, throwIfNoEntry: false }), own = entry && entry.dev + ":" + entry.ino;
    if (entry && !entry.isDirectory()) try { fs.unlinkSync(name); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!entry?.isDirectory() || only && !only.includes(own)) continue;
    process.chdir(name);
    if (id(".") !== own) fail();
    wipe(own);
    process.chdir("..");
    if (id(".") !== self || id(name) !== own) fail();
    fs.rmdirSync(name);
  }
};
const serve = request => {
  if (id(".") !== request.expect) fail();
  if (request.op === "attempt") {
    const name = fs.mkdtempSync(request.prefix); process.chdir(name);
    if (id("..") !== request.expect || id("../" + name) !== id(".") || fs.readdirSync(".").length > 0) fail();
    for (const [file, text] of request.files) fs.writeFileSync(file, text, { mode: 0o600, flag: "wx" });
    return { name, identity: id(".") };
  }
  if (request.op === "read") {
    if (id("../" + request.name) !== request.expect) fail();
    const fd = fs.openSync("output.json", fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const found = fs.fstatSync(fd);
    const buffer = Buffer.alloc(found.isFile() && found.size <= request.max ? request.max + 1 : 0);
    let length = 0; for (let count = -1; count !== 0 && length < buffer.length; length += count) count = fs.readSync(fd, buffer, length, buffer.length - length, null);
    return { file: found.isFile(), size: found.size, data: buffer.subarray(0, length).toString("base64") };
  }
  wipe(request.expect, request.attempts); process.chdir("..");
  if (id(request.name) === request.expect) fs.rmdirSync(request.name); else fail();
  return {};
};
let input = "";
process.stdin.setEncoding("utf8").on("data", chunk => {
  for (input += chunk; input.includes("\n"); input = input.slice(input.indexOf("\n") + 1)) {
    let reply; try { reply = serve(JSON.parse(input.slice(0, input.indexOf("\n")))); } catch (error) { reply = { error: error.code ?? String(error.message) }; }
    process.stdout.write(JSON.stringify(reply) + "\n");
  }
});
`;

/** A one-off DIRECTORY_HELPER request run in `directory` (the run directory's removal), bounded by a minute. */
async function inDirectory(directory: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await runProcessGroup(process.execPath, ["-e", DIRECTORY_HELPER], { cwd: directory, env: {}, timeoutMs: 60_000, maxOutputBytes: 4_096, stdin: `${JSON.stringify(request)}\n` });
  try { return JSON.parse(result.stdout) as Record<string, unknown>; }
  catch { return { error: result.timedOut ? "the directory operation was stopped" : `the directory operation failed: ${result.stderr.slice(0, 200)}` }; }
}

interface DirectoryHelper { request: (request: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) => Promise<Record<string, unknown>>; close: () => void }

/**
 * A DIRECTORY_HELPER kept running in `directory` for an attempt's requests, each answered in turn or, once its bound
 * passes or `signal` aborts, by stopping the helper. A helper that cannot be started there counts as a replaced directory.
 */
function directoryHelper(directory: string): DirectoryHelper {
  const child = spawn(process.execPath, ["-e", DIRECTORY_HELPER], { cwd: directory, env: {}, stdio: ["pipe", "pipe", "ignore"] });
  let pending: ((reply: Record<string, unknown>) => void) | undefined;
  let gone: Record<string, unknown> | undefined;
  let buffered = "";
  const answer = (reply: Record<string, unknown>) => { const resolve = pending; pending = undefined; resolve?.(reply); };
  child.once("error", () => answer(gone = { error: "EREPLACED" }));
  child.once("close", () => answer(gone ??= { error: "the directory operation was stopped" }));
  child.stdin.on("error", () => { /* the helper is gone; its close answers */ });
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffered += chunk;
    if (!buffered.includes("\n")) return;
    try { answer(JSON.parse(buffered.slice(0, buffered.indexOf("\n"))) as Record<string, unknown>); } catch { answer({ error: "the directory operation failed" }); }
    buffered = "";
  });
  const stop = () => child.kill("SIGKILL");
  return {
    request: (request, timeoutMs, signal) => new Promise(resolve => {
      if (gone) { resolve(gone); return; }
      const timer = setTimeout(stop, timeoutMs);
      pending = reply => { clearTimeout(timer); signal?.removeEventListener("abort", stop); resolve(reply); };
      if (signal?.aborted) stop();
      else signal?.addEventListener("abort", stop, { once: true });
      child.stdin.write(`${JSON.stringify(request)}\n`);
    }),
    close: () => { child.stdin.end(); stop(); },
  };
}

const SHORT_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const HEX4 = /^[\da-f]{4}$/i;

/** One level of JSON string escapes decoded, with, for each escape, where its unit sits here (`at`) and where it ended in the level below (`to`). */
interface EscapeLevel { text: string; at: Uint32Array; to: Uint32Array }

/**
 * `text` with every secret redacted as written and under up to MAX_ESCAPE_DEPTH levels of JSON string escaping (short
 * escapes, or `\uXXXX` in either hex case): the escapes are decoded one level at a time, each in linear time and memory,
 * keeping only where each escape sat, and every occurrence at any level, overlapping ones included, marks its whole
 * original span, overlapping spans merged, so a shorter secret never leaves part of a longer one. A line still escaped
 * past that depth is redacted whole.
 */
function redact(text: string, secrets: readonly string[]): string {
  const values = secrets.filter(secret => secret.length > 0);
  // reach[i] is the furthest end of a redacted span that starts at i (0: none), allocated at the first one.
  let reach: Uint32Array | undefined;
  const cover = (from: number, to: number) => { reach ??= new Uint32Array(text.length); reach[from] = Math.max(reach[from], to); };
  const original = (levels: readonly EscapeLevel[], index: number) => levels.reduceRight((at, level) => below(level, at), index);
  const levels: EscapeLevel[] = [];
  for (let current = text; values.length > 0;) {
    for (const value of values) {
      for (let at = current.indexOf(value); at !== -1; at = current.indexOf(value, at + 1)) cover(original(levels, at), original(levels, at + value.length));
    }
    const next = current.includes("\\") ? unescapeLevel(current) : undefined;
    if (next === undefined) break;
    if (levels.length === MAX_ESCAPE_DEPTH) {
      // Each line of `text` holding an escape still pending at the last level is withheld whole, each found once.
      let covered = 0;
      for (let index = current.indexOf("\\"); index !== -1; index = current.indexOf("\\", index + 2)) {
        if (!(Object.hasOwn(SHORT_ESCAPES, current[index + 1] ?? "") || current[index + 1] === "u")) continue;
        const at = original(levels, index);
        if (at < covered) continue;
        covered = text.includes("\n", at) ? text.indexOf("\n", at) : text.length;
        cover(text.lastIndexOf("\n", at) + 1, covered);
      }
      break;
    }
    levels.push(next);
    current = next.text;
  }
  if (reach === undefined) return redactText(text, secrets);
  const parts: string[] = [];
  let kept = 0;
  for (let index = 0, start = -1, end = 0; index <= text.length; index += 1) {
    const to = index < text.length ? reach[index] : 0;
    if (to !== 0 && start !== -1 && index <= end) { end = Math.max(end, to); continue; }
    if (start !== -1 && (to !== 0 || index === text.length)) { parts.push(text.slice(kept, start), "[REDACTED]"); kept = end; start = -1; }
    if (to !== 0) { start = index; end = to; }
  }
  parts.push(text.slice(kept));
  return redactText(parts.join(""), secrets);
}

/** Where unit `index` of `level` (or its end, at its length) started in the level below, found by binary search. */
function below(level: EscapeLevel, index: number): number {
  let low = 0;
  for (let high = level.at.length, middle = high >>> 1; low < high; middle = (low + high) >>> 1) if (level.at[middle] < index) low = middle + 1; else high = middle;
  return low === 0 ? index : level.to[low - 1] + index - level.at[low - 1] - 1;
}

/** One level of JSON string escapes decoded into a buffer, or undefined when `text` holds none. */
function unescapeLevel(text: string): EscapeLevel | undefined {
  const units = new Uint16Array(text.length);
  const at = new Uint32Array(text.length >>> 1);
  const to = new Uint32Array(at.length);
  let [size, length, done] = [0, 0, 0];
  for (let index = text.indexOf("\\"); index !== -1; index = text.indexOf("\\", index)) {
    const next = text[index + 1] ?? "";
    const hex = next === "u" && HEX4.test(text.slice(index + 2, index + 6));
    if (!Object.hasOwn(SHORT_ESCAPES, next) && !hex) { index += 1; continue; }
    for (; done < index; done += 1) units[length++] = text.charCodeAt(done);
    at[size] = length;
    units[length++] = hex ? Number.parseInt(text.slice(index + 2, index + 6), 16) : SHORT_ESCAPES[next].charCodeAt(0);
    done = index + (hex ? 6 : 2);
    to[size++] = done;
    index = done;
  }
  if (size === 0) return undefined;
  for (; done < text.length; done += 1) units[length++] = text.charCodeAt(done);
  return { text: Buffer.from(units.buffer, 0, length * 2).toString("utf16le"), at: at.slice(0, size), to: to.slice(0, size) };
}

/** A JSON value with `redact` applied to every string and key, and core `redactJson` to every other value. */
function redactValue<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === "string") return redact(value, secrets) as T;
  if (Array.isArray(value)) return value.map(item => redactValue(item, secrets)) as T;
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, secrets), redactValue(item, secrets)])) as T;
  return redactJson(value, secrets);
}

/** An answer rejected by validation, with what the repair prompt echoes back. */
interface Rejection { errors: string[]; rejected: string | undefined }

/** A read answer: `text` is an output file's content, `line` the stdout line the answer was parsed from. */
type OutputRead = { value: Record<string, unknown>; text?: string; line?: string } | { error: string; text?: string } | { overrun: string };

/** The profile's own configuration errors: an invalid profile, and a model the CLI could read as an option. */
function profileDiagnostics(config: ReviewFnConfig, error: (code: string, text: string) => void): void {
  const profile = config.harness.profileDefinition;
  if (!profile) return void error("REVIEWFN_HARNESS_PROFILE_REQUIRED", "The cli harness runs only panel slots whose harness.profile names a profile of the trusted panel policy.");
  const issues = validateHarnessProfile(profile).issues;
  if (issues.length) {
    const detail = issues.map(issue => `${issue.path || "/"} ${issue.message}`).join("; ");
    return void error("REVIEWFN_HARNESS_PROFILE_INVALID", `Profile ${String(config.harness.profile)} is invalid: ${detail}`);
  }
  const model = config.inference.model;
  if (profile.argv.includes("{model}") && model === "configured") error("REVIEWFN_MODEL_REQUIRED", "The profile passes {model} to the CLI, so the slot must name an explicit model.");
  if (model.startsWith("-") || /[\r\n\0]/.test(model)) error("REVIEWFN_MODEL_INVALID", "The model may not start with '-' or contain line breaks or NUL, so it can never read as a CLI option.");
}

/**
 * Read a `stderr-regex` model report, bounded in time by `MODEL_REPORT_TIMEOUT_MS` and by what is left of the run's own
 * deadline, whichever is nearer, so a reporter holds a run at most `MODEL_REPORT_ABORT_GRACE_MS` past its harness
 * timeout: the same grace an aborted run gives, so the report of a CLI stopped at its deadline is still read. The models
 * it matched before it stopped are reported models, so a mismatch it already found still voids the run; a reporter that
 * cannot finish ends the run timed_out (or canceled).
 */
async function reportStderrModel(run: AttemptContext, reporter: Reporter, stderr: string): Promise<SlotHarnessOutput | undefined> {
  const timeoutMs = Math.max(MODEL_REPORT_ABORT_GRACE_MS, Math.min(MODEL_REPORT_TIMEOUT_MS, run.deadline - Date.now()));
  const matched = await reporter.match(stderr, timeoutMs, run.input.signal);
  for (const value of [matched.first, matched.mismatch, matched.last]) run.state.note(value);
  return matched.terminal ? run.state.finish(matched.terminal, matched.reason ?? "The model reporter stopped.") : undefined;
}

/**
 * What a `stderr-regex` reporter matched: the first nonblank capture, the first that is not the configured model, and
 * (when it finished) the last. Nothing else is kept, so its memory stays linear in stderr whatever the pattern captures.
 */
export interface ReporterOutcome { first?: string; mismatch?: string; last?: string; terminal?: "timed_out" | "canceled" | "failed"; reason?: string }

interface Reporter { match: (text: string, timeoutMs: number, signal?: AbortSignal) => Promise<ReporterOutcome>; dispose: () => void }

/**
 * A `stderr-regex` reporter in a worker thread (an ES module from a `data:` URL, whatever the parent's module flags),
 * started ahead of its text. It posts the first and the first mismatching capture as soon as it finds them. A pattern
 * that backtracks without end is terminated after `timeoutMs`; once `signal` aborts it gets `MODEL_REPORT_ABORT_GRACE_MS`.
 * Either way the captures found so far are kept.
 */
function startReporter(source: string, model: string): Reporter {
  const worker = new Worker(REPORTER_MODULE, { workerData: { source, model } });
  const outcome: ReporterOutcome = {};
  let failure: string | undefined;
  let finished: ((done: boolean) => void) | undefined;
  worker.on("message", (posted: ReporterOutcome & { done?: true }) => {
    if (posted.first !== undefined) outcome.first = posted.first;
    if (posted.mismatch !== undefined) outcome.mismatch = posted.mismatch;
    if (posted.done) { outcome.last = posted.last; finished?.(true); }
  });
  worker.once("error", error => { failure = `The model reporter failed: ${message(error)}`; finished?.(false); });
  worker.once("exit", () => { failure ??= "The model reporter stopped without a result."; finished?.(false); });
  return {
    match: (text, timeoutMs, signal) => new Promise(resolve => {
      const timers: NodeJS.Timeout[] = [];
      const end = (stop?: { terminal: NonNullable<ReporterOutcome["terminal"]>; reason: string }) => {
        finished = undefined;
        for (const timer of timers) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ ...outcome, ...stop });
      };
      finished = done => end(done ? undefined : { terminal: "failed", reason: failure ?? "The model reporter failed." });
      const onAbort = () => {
        const timedOut = signal?.reason instanceof Error && signal.reason.name === "TimeoutError";
        timers.push(setTimeout(() => end(timedOut ? { terminal: "timed_out", reason: "The CLI run reached its deadline while its model report was read." } : { terminal: "canceled", reason: "The CLI run was canceled while its model report was read." }), MODEL_REPORT_ABORT_GRACE_MS));
      };
      timers.push(setTimeout(() => end({ terminal: "timed_out", reason: `The model reporter did not finish within ${timeoutMs} ms, so the served model was not fully read.` }), timeoutMs));
      if (failure !== undefined) return end({ terminal: "failed", reason: failure });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      worker.postMessage(text);
    }),
    dispose: () => { void worker.terminate(); },
  };
}

/** Every reported model a `stderr-regex` reporter finds in `text`, in a worker that is always terminated. */
export async function matchReporter(text: string, source: string, model: string, timeoutMs: number, signal?: AbortSignal): Promise<ReporterOutcome> {
  const reporter = startReporter(source, model);
  try { return await reporter.match(text, timeoutMs, signal); }
  finally { reporter.dispose(); }
}

const REPORTER_MODULE = new URL(`data:text/javascript,${encodeURIComponent(`import { parentPort, workerData } from "node:worker_threads";
parentPort.once("message", text => {
  const { source, model } = workerData;
  let first, mismatch, last;
  for (const match of text.matchAll(new RegExp(source, "gu"))) {
    const value = match[1];
    if (typeof value !== "string" || !value.trim()) continue;
    if (first === undefined) { first = value; parentPort.postMessage({ first }); }
    if (mismatch === undefined && model !== "configured" && value !== model) { mismatch = value; parentPort.postMessage({ mismatch }); }
    last = value;
  }
  parentPort.postMessage({ done: true, last });
});`)}`);

/** The attempt's answer as the CLI wrote it, with its `json-path` model report read. */
async function readAnswer(run: AttemptContext, outputFile: string, stdout: string, helper: DirectoryHelper): Promise<OutputRead> {
  const output = run.profile.outputVia === "file" ? await readOutputFile(run, helper, outputFile, run.state.remainingOutputBytes()) : stdoutObject(stdout);
  if ("text" in output && output.text !== undefined) run.state.recordOutputFile(output.text);
  if ("value" in output && run.profile.modelReport.startsWith("json-path:")) run.state.note(valueAtPath(output.value, run.profile.modelReport.slice("json-path:".length)));
  return output;
}

/**
 * The answer the slot's schema accepts and its errors. An answer that validates as written is taken unchanged, so a
 * report field the schema allows is never removed. Only an answer that fails is tried again without its `json-path`
 * report where the schema closes an object to it, and then that copy's errors are the ones its repair attempt sees.
 */
function validated(run: AttemptContext, value: Record<string, unknown>): { value: Record<string, unknown>; errors: string[] } {
  const errors = run.validate(value);
  if (!errors.length || !run.profile.modelReport.startsWith("json-path:")) return { value, errors };
  const stripped = withoutReportField(value, run.profile.modelReport.slice("json-path:".length).split("."), run.schema);
  if (stripped === value || !isRecord(stripped)) return { value, errors };
  return { value: stripped, errors: run.validate(stripped) };
}

/**
 * The attempt's terminal outcome before its answer is judged, in one precedence: a caller's cancellation, including one
 * that arrived after the process exited while its answer and model report were read; then any
 * overrun of the time or output bound, whether the watcher, the runner or the output read found it; then a reported
 * model mismatch; then a nonzero exit (quota_exhausted when stderr says so). A file overrun is never classified by the
 * exit that followed it.
 */
function terminalOutcome(run: AttemptContext, attempt: number, result: CommandResult, output: OutputRead, fileOverrun: string | undefined): SlotHarnessOutput | undefined {
  const { state } = run;
  if (run.input.signal?.aborted || (result.canceled && fileOverrun === undefined)) return state.finish("canceled", "The CLI run was canceled.");
  const overrun = fileOverrun ?? ("overrun" in output ? output.overrun : undefined);
  if (overrun !== undefined) return state.finish("timed_out", overrun);
  if (result.timedOut) return state.finish("timed_out", "The CLI run exceeded its configured time or output bound.");
  const mismatch = state.mismatchReason();
  if (mismatch) return state.finish("failed", mismatch);
  if (result.code === 0) return undefined;
  const detail = result.stderr.trim();
  state.push("error", { attempt, exitCode: result.code, signal: result.signal });
  return state.finish(QUOTA.test(detail) ? "quota_exhausted" : "failed", state.retain(detail, MAX_DETAIL_CHARS) || `The CLI exited with ${String(result.code ?? result.signal)}.`);
}

/**
 * The accepted answer without its `json-path` report wherever the canonical payload schema closes an object to it. The
 * payload keeps whole sections, so a report the caller's schema allows inside one (an `uninspected` or `evidence` item,
 * say) is not part of the payload, and is never judged as one.
 */
function payloadAnswer(run: AttemptContext, value: Record<string, unknown>): Record<string, unknown> {
  if (!run.profile.modelReport.startsWith("json-path:")) return value;
  const stripped = withoutReportField(value, run.profile.modelReport.slice("json-path:".length).split("."), payloadSchema());
  return isRecord(stripped) ? stripped : value;
}

/** The harness payload schema with its local `#/$defs/` references inlined (a cyclic one is kept), for the ownership rule. */
let inlinedPayloadSchema: unknown;
const payloadSchema = (): unknown => (inlinedPayloadSchema ??= inlineDefinitions(harnessOutputSchema, harnessOutputSchema.$defs, []));

function inlineDefinitions(schema: unknown, definitions: Readonly<Record<string, unknown>>, seen: readonly string[]): unknown {
  if (Array.isArray(schema)) return schema.map(item => inlineDefinitions(item, definitions, seen));
  if (!isRecord(schema)) return schema;
  const name = typeof schema.$ref === "string" && schema.$ref.startsWith("#/$defs/") ? schema.$ref.slice("#/$defs/".length) : undefined;
  if (name !== undefined && Object.keys(schema).length === 1 && Object.hasOwn(definitions, name) && !seen.includes(name)) return inlineDefinitions(definitions[name], definitions, [...seen, name]);
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$defs").map(([key, item]) => [key, inlineDefinitions(item, definitions, seen)]));
}

/** The completed run for an answer that validates and confirms its model, or the rejection that earns a repair. */
function accept(run: AttemptContext, attempt: number, output: OutputRead): SlotHarnessOutput | Rejection {
  if (!("value" in output)) return { errors: ["error" in output ? output.error : "The CLI produced no answer."], rejected: "text" in output ? output.text : undefined };
  // The repair prompt echoes the answer's own text, never a re-serialization: an object JSON.parse accepted may still
  // be too deep for JSON.stringify.
  const rejected = output.text ?? output.line ?? serialized(output.value);
  const rejection = (errors: string[]): Rejection => ({ errors, rejected });
  // An answer the slot's schema rejects goes to its repair attempt as it is, never through payload normalization.
  const { value, errors } = validated(run, output.value);
  if (errors.length) return rejection(errors);
  const payload = normalizePayload(payloadAnswer(run, value));
  const payloadErrors = validateHarnessPayload(payload);
  if (payloadErrors.length) return rejection(payloadErrors);
  // Only an answer that would be accepted must confirm its model; an invalid one still gets its repair attempt.
  const unconfirmed = run.state.unconfirmedModel();
  if (unconfirmed) return run.state.finish("failed", unconfirmed);
  run.state.push("completed", { attempt });
  return run.state.complete(redactValue(payload, run.secrets));
}

/** The last JSON object line of stdout, with the line it was parsed from. */
function stdoutObject(stdout: string): OutputRead {
  return lastJsonObject(stdout) ?? { error: "No stdout line parses as a JSON object." };
}

/** `value` as JSON, or undefined when it cannot be serialized (too deep, say). */
function serialized(value: unknown): string | undefined {
  try { return JSON.stringify(value); } catch { return undefined; }
}
/**
 * The output file, read by the attempt's helper inside the attempt directory the adapter created (never through a link
 * that replaced it, nor while its name holds anything else), without following a link, within the remaining output
 * budget, as exactly one JSON object. The helper already runs, so the read needs no new process; it is bounded by the
 * run's remaining time plus MODEL_REPORT_TIMEOUT_MS but not by the caller's signal, so the model a file reports is read
 * even once the run was canceled or timed out.
 */
async function readOutputFile(run: AttemptContext, helper: DirectoryHelper, file: string, maxBytes: number): Promise<OutputRead> {
  const max = Math.max(0, maxBytes);
  const directory = path.dirname(file);
  const read = await helper.request({ op: "read", expect: run.identities.get(directory), name: path.basename(directory), max }, Math.max(0, run.deadline - Date.now()) + MODEL_REPORT_TIMEOUT_MS);
  if (typeof read.error === "string") return { error: read.error === "ENOENT" ? "The CLI wrote no output file." : read.error === "EREPLACED" ? DIRECTORY_REPLACED : `The output file could not be opened: ${read.error}` };
  if (read.file !== true) return { error: "The output file is not a regular file." };
  if (Number(read.size) > max) return { overrun: `The CLI output file (${Number(read.size)} bytes) exceeded the remaining ${max}-byte output budget.` };
  const buffer = Buffer.from(String(read.data), "base64");
  if (buffer.length > max) return { overrun: `The CLI output file exceeded the remaining ${max}-byte output budget.` };
  const text = buffer.toString("utf8");
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value)) return { value, text };
  } catch { /* reported below */ }
  return { error: "The output file is not exactly one JSON object.", text };
}

/**
 * Measure a running CLI's output file (without following a link) plus its stdout and stderr bytes, reported through
 * `onOutput`, against one output budget, and abort the returned signal, which also follows the caller's, once together
 * they outgrow it.
 */
function watchOutputFile(file: string, maxBytes: number, parent: AbortSignal | undefined): { signal: AbortSignal; stop: () => void; overrun: () => string | undefined; onOutput: (bytes: number) => void; peak: () => number; settle: () => Promise<void> } {
  const controller = new AbortController();
  let overrun: string | undefined;
  let checking = false;
  let streamed = 0;
  let peak = 0;
  let pending: Promise<void> = Promise.resolve();
  const check = () => {
    if (peak === 0 || streamed + peak <= maxBytes || overrun !== undefined) return;
    overrun = `The CLI output file (${peak} bytes at its largest) grew past the remaining ${Math.max(0, maxBytes)}-byte output budget with ${streamed} bytes of stdout and stderr while it ran.`;
    controller.abort();
  };
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    pending = lstat(file).then(stat => { peak = Math.max(peak, stat.isFile() ? stat.size : 0); check(); }, () => { /* not written yet */ }).finally(() => { checking = false; });
  }, OUTPUT_FILE_POLL_MS);
  timer.unref();
  return {
    signal: controller.signal,
    stop: () => { clearInterval(timer); parent?.removeEventListener("abort", onParentAbort); },
    onOutput: bytes => { streamed += bytes; check(); },
    overrun: () => { check(); return overrun; },
    peak: () => peak,
    // One last measurement after the CLI ended, so a file written after the last poll is charged too.
    settle: () => pending.then(() => lstat(file)).then(stat => { peak = Math.max(peak, stat.isFile() ? stat.size : 0); }, () => { /* never written */ }),
  };
}

/**
 * The schema shown to the CLI for a `json-path` model report: the slot's schema with the report declared, and required,
 * on every object schema on the path that does not declare the key yet, including each object `allOf` branch, so a CLI
 * that enforces the schema, even one that emits only declared properties, can still report its model. Where the object
 * is closed to the key (`additionalProperties: false`, or `unevaluatedProperties: false`, with no `properties` or
 * `patternProperties` entry for it) the key is declared as a string at the rest of the path; where an
 * `additionalProperties` schema owns it, it is declared as that schema. It descends through the property, owning and
 * array `items` schemas on the path. An `allOf` entry that is `{}` or `true` is ignored. A node where a
 * `patternProperties` pattern matches the key (its schema is shared by every sibling key it matches), or whose ownership
 * of the key cannot be settled statically (`$ref`, `anyOf`, `oneOf`, `not`, a conditional or `dependentSchemas`), is
 * shown unchanged, so the slot's schema must declare the report there itself. The caller's schema is never changed.
 */
export function withModelReportField(schema: Readonly<Record<string, unknown>>, modelReport: string): Readonly<Record<string, unknown>> {
  if (!modelReport.startsWith("json-path:")) return schema;
  return declarePath(schema, modelReport.slice("json-path:".length).split("."));
}

/** The schema with the report declared, and required, along `keys`. */
function declarePath(schema: Readonly<Record<string, unknown>>, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const [key, ...rest] = keys;
  if (key === undefined) return schema;
  // A numeric step indexes an array schema, as valueAtPath reads an array; elsewhere it names a property. The items
  // schemas are shared, so every item declares the report, and every item may have it removed. They are the ones removal
  // follows (itemSchemas): the node's own items and its allOf branches', none below an unsettled array node.
  if (isArrayStep(schema, key)) {
    if (isUnsettledArray(schema)) return schema;
    const items = isRecord(schema.items) ? declarePath(schema.items, rest) : schema.items;
    return declareBranches(schema, items === schema.items ? schema : { ...schema, items }, keys);
  }
  // A pattern schema is shared by every key it matches, so it can neither allow the report for the named key alone nor
  // sit beside a declared copy of it (strict Ajv refuses the overlap): a pattern-owned key is shown as written.
  if (ownership(schema, key).kind === "unsettled" || patternOwned(schema, key)) return schema;
  return declareBranches(schema, declareOwn(schema, key, rest), keys);
}

/** `shown` with the report declared along `keys` in each non-trivial `allOf` branch of `schema`. */
function declareBranches(schema: Readonly<Record<string, unknown>>, shown: Readonly<Record<string, unknown>>, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!Array.isArray(schema.allOf)) return shown;
  const branches: unknown[] = schema.allOf;
  const allOf = branches.map(branch => isRecord(branch) && !isTrivial(branch) ? declarePath(branch, keys) : branch);
  return allOf.every((branch, index) => branch === branches[index]) ? shown : { ...shown, allOf };
}

/**
 * The node itself, its `allOf` aside: below the key's declared schema; or, on an object schema that does not declare
 * the key, the key declared, and required, as the additional-properties schema that owns it or, on a closed object, as a
 * new report field.
 */
function declareOwn(schema: Readonly<Record<string, unknown>>, key: string, rest: readonly string[]): Readonly<Record<string, unknown>> {
  const owned = ownOwnership(schema, key);
  let child: unknown;
  if (owned.kind === "open" && owned.via === "declared") {
    const [declared] = owned.children;
    const next = isRecord(declared) ? declarePath(declared, rest) : declared;
    if (next !== declared) child = next;
  } else if (isObjectSchema(schema)) {
    const [owner] = owned.kind === "open" ? owned.children : [];
    child = owned.kind === "open" && isRecord(owner) && !isTrivial(owner) ? declarePath(owner, rest) : reportField(rest);
  }
  if (child === undefined) return schema;
  const required = Array.isArray(schema.required) ? schema.required : [];
  return { ...schema, properties: { ...(isRecord(schema.properties) ? schema.properties : {}), [key]: child }, ...(required.includes(key) ? {} : { required: [...required, key] }) };
}

/** Whether a `patternProperties` pattern of the node, or of a non-trivial `allOf` branch, matches `key`. */
function patternOwned(schema: Readonly<Record<string, unknown>>, key: string): boolean {
  const patterns = isRecord(schema.patternProperties) ? Object.keys(schema.patternProperties) : [];
  const branches: unknown[] = Array.isArray(schema.allOf) ? schema.allOf : [];
  return patterns.some(pattern => matches(pattern, key) !== false) || branches.some(branch => isRecord(branch) && !isTrivial(branch) && patternOwned(branch, key));
}

/** Whether a `patternProperties` pattern matches a key; undefined for a pattern that does not compile. */
function matches(pattern: string, key: string): boolean | undefined {
  try { return new RegExp(pattern, "u").test(key); }
  catch { return undefined; }
}

/**
 * Who owns a key of an object schema node: the child schemas that validate its value (`via` says which keyword, for the
 * node itself), a node closed to it, or a node whose ownership is not settled statically.
 */
type Ownership = { kind: "open"; children: unknown[]; via?: "declared" | "pattern" | "additional" } | { kind: "closed" } | { kind: "unsettled" };

/** Keywords that make which schema owns a property depend on the value or another document. */
const UNSETTLED = ["$ref", "$dynamicRef", "anyOf", "oneOf", "not", "if", "then", "else", "dependentSchemas"];

const isObjectSchema = (schema: Readonly<Record<string, unknown>>): boolean => schema.type === "object" || ["properties", "patternProperties", "additionalProperties", "unevaluatedProperties"].some(keyword => keyword in schema);
const isTrivial = (schema: unknown): boolean => schema === true || (isRecord(schema) && Object.keys(schema).length === 0);
const isArrayStep = (schema: unknown, key: string): boolean => /^\d+$/.test(key) && isRecord(schema) && (schema.type === "array" || "items" in schema);

/** The node's ownership of `key`, with its non-trivial `allOf` branches: closed when any of them closes it. */
function ownership(schema: unknown, key: string): Ownership {
  if (schema === undefined || schema === true) return { kind: "open", children: [] };
  if (!isRecord(schema) || UNSETTLED.some(keyword => keyword in schema)) return { kind: "unsettled" };
  if (schema.allOf !== undefined && !Array.isArray(schema.allOf)) return { kind: "unsettled" };
  const branches: unknown[] = Array.isArray(schema.allOf) ? schema.allOf.filter(branch => !isTrivial(branch)) : [];
  // unevaluatedProperties also sees what the allOf branches evaluate, which this static rule does not follow.
  if (branches.length && "unevaluatedProperties" in schema) return { kind: "unsettled" };
  let owned = ownOwnership(schema, key);
  for (const branch of branches) {
    const next = ownership(branch, key);
    if (owned.kind === "unsettled" || next.kind === "unsettled") return { kind: "unsettled" };
    owned = owned.kind === "closed" || next.kind === "closed" ? { kind: "closed" } : { kind: "open", children: [...owned.children, ...next.children] };
  }
  return owned;
}

/** The node's own ownership of `key`: its declared property and matching patterns, else its additional properties. */
function ownOwnership(schema: Readonly<Record<string, unknown>>, key: string): Ownership {
  const children: unknown[] = [];
  let via: "declared" | "pattern" = "pattern";
  if (isRecord(schema.properties) && Object.hasOwn(schema.properties, key)) { children.push(schema.properties[key]); via = "declared"; }
  if (isRecord(schema.patternProperties)) {
    for (const [pattern, child] of Object.entries(schema.patternProperties)) {
      const matched = matches(pattern, key);
      if (matched === undefined) return { kind: "unsettled" };
      if (matched) children.push(child);
    }
  }
  if (children.length) return { kind: "open", children, via };
  const additional = "additionalProperties" in schema ? schema.additionalProperties : schema.unevaluatedProperties;
  return additional === false ? { kind: "closed" } : { kind: "open", children: [additional], via: "additional" };
}

/** A required string at the remaining dotted path, through new objects and arrays. */
function reportField(keys: readonly string[]): Record<string, unknown> {
  let field: Record<string, unknown> = { type: "string" };
  for (const key of [...keys].reverse()) {
    field = /^\d+$/.test(key) ? { type: "array", minItems: Number(key) + 1, items: field } : { type: "object", properties: { [key]: field }, required: [key] };
  }
  return field;
}

/** Whether which item schemas apply to an array node is not settled: it, or a non-trivial `allOf` branch, composes. */
function isUnsettledArray(schema: Readonly<Record<string, unknown>>): boolean {
  const unsettled = (node: unknown) => !isRecord(node) || UNSETTLED.some(keyword => keyword in node);
  if (unsettled(schema) || (schema.allOf !== undefined && !Array.isArray(schema.allOf))) return true;
  const branches: unknown[] = Array.isArray(schema.allOf) ? schema.allOf : [];
  return branches.some(branch => !isTrivial(branch) && unsettled(branch));
}

/** The item schemas that apply to an array: its own `items` and its `allOf` branches' (none below an unsettled node). */
function itemSchemas(schema: unknown): unknown[] {
  if (!isRecord(schema) || isUnsettledArray(schema)) return [];
  const branches: unknown[] = Array.isArray(schema.allOf) ? schema.allOf : [];
  return [...("items" in schema ? [schema.items] : []), ...branches.filter(branch => !isTrivial(branch)).flatMap(itemSchemas)];
}

/**
 * The answer without its `json-path` model report where the output schema closes an object to it, following the same
 * ownership as `withModelReportField` through properties, patterns, additional properties, `allOf` branches and, through
 * a numeric step, every array item. Only the objects and arrays on the path are copied, so the rest of the answer, however
 * deep, is never walked. Nothing is removed at or below a node whose ownership is not settled. The same value when
 * nothing was removed.
 */
function withoutReportField(value: unknown, keys: readonly string[], schema: unknown): unknown {
  const [key, ...rest] = keys;
  if (key === undefined) return value;
  if (Array.isArray(value) && /^\d+$/.test(key)) {
    const schemas = itemSchemas(schema);
    const next = value.map(item => schemas.reduce((current, items) => withoutReportField(current, rest, items), item));
    return next.some((item, index) => item !== value[index]) ? next : value;
  }
  if (!isRecord(value) || !Object.hasOwn(value, key)) return value;
  const owned = ownership(schema, key);
  if (owned.kind === "closed") {
    const kept = { ...value };
    delete kept[key];
    return kept;
  }
  if (owned.kind === "unsettled") return value;
  let child = value[key];
  for (const owner of owned.children) child = withoutReportField(child, rest, owner);
  return child === value[key] ? value : { ...value, [key]: child };
}

function outputContract(schema: Readonly<Record<string, unknown>>, profile: HarnessProfile): string {
  const lastLine = profile.outputVia === "stdout-last-json" ? "\nPrint the object on a single line, as the last line of your output." : "";
  return `Output contract: your final answer must be exactly one JSON object, with no prose and no code fence, that validates against this JSON Schema:\n${JSON.stringify(schema)}${lastLine}`;
}

/**
 * The base prompt again, with the rejected answer (cut to its first bytes) and why it was rejected. Both are redacted with
 * the run's secrets before the cut, as the transcript is, so no credential the CLI echoed reaches the next prompt.
 */
function repairPrompt(basePrompt: string, errors: readonly string[], previous: string | undefined, secrets: readonly string[]): string {
  const listed = redact(errors.slice(0, 50).map(error => `- ${error}`).join("\n"), secrets);
  const echoed = previous === undefined ? "(no JSON object was found)" : Buffer.from(redact(previous, secrets), "utf8").subarray(0, REPAIR_ECHO_BYTES).toString("utf8");
  const sections = [basePrompt, "Repair: your previous answer was rejected and this is the only repair attempt."];
  sections.push(`Validation errors:\n${listed}`, `Previous answer (at most ${REPAIR_ECHO_BYTES} bytes):\n${echoed}`);
  sections.push("Reply with exactly one JSON object that validates against the schema above.");
  return sections.join("\n\n");
}

type Payload = Omit<HarnessOutput, "terminal" | "events" | "transcript">;

/** A caller-schema-valid output as a 0.1 harness payload, as the other adapters convert it. */
function normalizePayload(value: Record<string, unknown>): Payload {
  const fields = value as Partial<HarnessOutput>;
  const { evidence, findings, inspectedPaths, uninspected } = fields;
  // A null requirements or assessments section the caller schema allowed is an empty one.
  return omitOptionalNulls({ requirements: fields.requirements ?? [], assessments: fields.assessments ?? [], evidence, findings, inspectedPaths, uninspected }) as Payload;
}

/** A run that produced no answer: every payload section empty and the whole review uninspected for `error`. */
function failure(terminal: HarnessOutput["terminal"], error: string): SlotHarnessOutput {
  const uninspected = [{ scope: "review", reason: error }];
  return { terminal, error, uninspected, requirements: [], assessments: [], evidence: [], findings: [], inspectedPaths: [], events: [] };
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Everything observed across a run's attempts: events, the redacted transcript, the reported models and the byte budget. */
class RunState {
  public harnessVersion: string | undefined;
  private readonly events: NormalizedRunEvent[] = [];
  private readonly transcript: string[] = [];
  /** Raw bytes counted against the output budget: stdout and stderr as the runner capped them, and each output file read. */
  private rawBytes = 0;
  private fileBytes = 0;
  /**
   * Whether any reported model differed from the configured one, compared on the raw values. It is carried to the panel
   * on its own, because the stored model (redacted and cut to length) can read the same as the configured model.
   */
  private mismatched = false;
  /** The first reported model that is not the configured one, as stored. */
  private mismatch: string | undefined;
  /** The model reported for the current attempt; a repair attempt must report its own. */
  private reported: string | undefined;
  private everReported: string | undefined;

  public constructor(private readonly model: string, private readonly profile: HarnessProfile, private readonly secrets: readonly string[], private readonly maxOutputBytes: number) {}

  /**
   * A stream the runner cut (at its time or byte bound, or on cancellation) may end inside a secret whose rest it dropped,
   * so its unterminated last line is withheld from the transcript.
   */
  public record(result: CommandResult): void {
    this.reported = undefined;
    this.fileBytes = 0;
    this.rawBytes += Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    const kept = (text: string) => !(result.timedOut || result.canceled) || text === "" || text.endsWith("\n") ? text : `${text.slice(0, text.lastIndexOf("\n") + 1)}[WITHHELD: the stream was cut]`;
    this.transcript.push(redact(`${kept(result.stdout)}\n${kept(result.stderr)}`, this.secrets));
  }

  public recordOutputFile(text: string): void {
    this.fileBytes = Buffer.byteLength(text);
    this.rawBytes += this.fileBytes;
    this.transcript.push(redact(text, this.secrets));
  }

  /** The largest output file size measured while the attempt ran: bytes beyond the file then read still count. */
  public chargeMeasured(peak: number): void {
    this.rawBytes += Math.max(0, peak - this.fileBytes);
  }

  /** A model the reporter named: a nonblank string, compared with the configured model before it is stored. */
  public note(value: unknown): void {
    if (typeof value !== "string" || !value.trim()) return;
    const stored = this.retain(value, MAX_MODEL_CHARS);
    this.reported = stored;
    this.everReported ??= stored;
    if (this.mismatched || this.model === "configured" || value === this.model) return;
    this.mismatched = true;
    this.mismatch = stored;
  }

  public mismatchReason(): string | undefined {
    return this.mismatched ? `model_mismatch: the CLI reported model ${String(this.mismatch)}, not the configured ${this.model}.` : undefined;
  }

  /** With a model reporter, a completing attempt must itself have reported the model that served it. */
  public unconfirmedModel(): string | undefined {
    if (this.profile.modelReport === "none" || this.reported !== undefined) return undefined;
    return `The CLI reported no model through ${this.profile.modelReport.split(":")[0]}, so the configured ${this.model} was not confirmed.`;
  }

  /**
   * The bytes the next attempt may produce: the limit less what is stored so far (the larger of the raw bytes and the
   * redacted transcript, so redaction can widen neither budget) and the separators the next attempt adds.
   */
  public remainingOutputBytes(): number {
    const stored = Math.max(this.rawBytes + this.transcript.length * 2, Buffer.byteLength(this.transcript.join("\n")));
    return this.maxOutputBytes - stored - 3;
  }

  public retain(value: string, max: number): string {
    const redacted = redact(value, this.secrets);
    return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
  }

  public complete(payload: Payload): SlotHarnessOutput {
    // A completed run is attributed to the model the accepted attempt reported, never to a rejected attempt's.
    if (this.reported !== undefined) this.everReported = this.reported;
    return this.bounded({ terminal: "completed", ...payload, events: [] });
  }

  public finish(terminal: HarnessOutput["terminal"], reason: string): SlotHarnessOutput {
    return this.bounded(failure(terminal, redact(reason, this.secrets)));
  }

  public push(type: NormalizedRunEvent["type"], data: Record<string, JsonValue>): void {
    if (this.events.length >= MAX_EVENTS) return;
    this.events.push({ sequence: this.events.length, at: new Date().toISOString(), type, data });
  }

  /**
   * The output with the run's events, transcript and observation, held to the limit the panel applies to each channel:
   * a channel over it ends the run timed_out, keeping what was observed. Cancellation keeps its terminal.
   */
  private bounded(answer: SlotHarnessOutput): SlotHarnessOutput {
    const telemetry = { events: redactValue(this.events, this.secrets), transcript: this.transcript.join("\n"), observed: this.observation() };
    const sizes = [Buffer.byteLength(telemetry.transcript), Buffer.byteLength(JSON.stringify(telemetry.events))];
    if (answer.terminal === "canceled" || sizes.every(size => size <= this.maxOutputBytes)) return { ...answer, ...telemetry };
    const reason = `The CLI output exceeded its ${this.maxOutputBytes}-byte budget once stored (transcript ${sizes[0]} bytes, events ${sizes[1]} bytes).`;
    return { ...failure("timed_out", reason), ...telemetry };
  }

  private observation(): SlotObservation {
    const observed: SlotObservation = {};
    if (this.harnessVersion) observed.harnessVersion = this.harnessVersion;
    // A reported model that matches is the configured model; any other is reported as served, with the raw comparison's
    // verdict, so the panel voids the run even when the stored model reads the same as the configured one.
    if (this.profile.modelReport !== "none") {
      if (this.mismatched) { observed.model = this.mismatch; observed.modelMismatch = true; }
      else if (this.everReported !== undefined) observed.model = this.model === "configured" ? this.everReported : this.model;
    }
    const limitations: SlotRunLimitation[] = [];
    if (this.profile.modelReport === "none") limitations.push("model_unverified");
    if (this.profile.capabilities.sandbox === "tree-verified-only") limitations.push("sandbox_tree_verified_only");
    if (limitations.length) observed.limitations = limitations;
    return observed;
  }
}
