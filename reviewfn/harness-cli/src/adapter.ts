import { constants } from "node:fs";
import { access, lstat, mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import {
  collectSecrets, harnessOutputSchema, omitOptionalNulls, redactJson, redactText, resolveTrustedExecutable, runProcessGroup, structuredOutputValidator,
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
/** How often a running CLI's output file is measured against the remaining output budget. */
const OUTPUT_FILE_POLL_MS = 100;
/** How long a `stderr-regex` model reporter may match, in a worker that is terminated when it runs over or the run is canceled. */
const MODEL_REPORT_TIMEOUT_MS = 2_000;
/** How long a reporter still runs after the run is aborted, so a timed-out CLI's report is read but cancellation stays prompt. */
const MODEL_REPORT_ABORT_GRACE_MS = 100;
/** The longest pre-release or build suffix a version token is read with, which keeps the version scan linear. */
const MAX_VERSION_SUFFIX = 128;
const ENV_NAME = /^[A-Z_a-z]\w*$/;
const QUOTA = /quota|rate.?limit|usage.?limit|credit balance|too many requests/i;

const isDigit = (char: string | undefined): boolean => char !== undefined && char >= "0" && char <= "9";
const isAlphanumeric = (char: string | undefined): boolean => char !== undefined && /^[0-9A-Za-z]$/.test(char);
/** A character that may not adjoin a version token: a word character or a dot. */
const joinsToken = (char: string | undefined): boolean => char !== undefined && (char === "." || /^\w$/.test(char));
const isSuffixCharacter = (char: string | undefined): boolean => char === "-" || char === "." || isAlphanumeric(char);

function digitsEnd(text: string, index: number): number {
  let end = index;
  while (isDigit(text[end])) end += 1;
  return end;
}

/** The end of the longest pre-release or build suffix from `from` that ends in a letter or digit and adjoins no word character or dot. */
function suffixEnd(text: string, from: number): number | undefined {
  let runEnd = from;
  while (runEnd < from + MAX_VERSION_SUFFIX && isSuffixCharacter(text[runEnd])) runEnd += 1;
  for (let end = runEnd; end > from; end -= 1) {
    const follows = end === runEnd ? !joinsToken(text[end]) : text[end] === "-";
    if (follows && isAlphanumeric(text[end - 1])) return end;
  }
  return undefined;
}

/** The version token starting at `start` (an optional `v`, two or more dotted numbers, an optional suffix), or undefined. */
function versionAt(text: string, start: number): string | undefined {
  const first = text[start] === "v" ? start + 1 : start;
  let end = digitsEnd(text, first);
  if (end === first) return undefined;
  let parts = 1;
  while (text[end] === "." && isDigit(text[end + 1])) { end = digitsEnd(text, end + 1); parts += 1; }
  if (parts < 2) return undefined;
  const suffix = text[end] === "-" || text[end] === "+" ? suffixEnd(text, end + 1) : undefined;
  if (suffix !== undefined) return text.slice(first, suffix);
  return joinsToken(text[end]) ? undefined : text.slice(first, end);
}

/** The first version token of `text`, read by a linear scan rather than a backtracking pattern. */
function firstVersion(text: string): string | undefined {
  for (let index = 0; index < text.length; index += 1) {
    if (index > 0 && joinsToken(text[index - 1])) continue;
    const version = versionAt(text, index);
    if (version !== undefined) return version;
  }
  return undefined;
}

/**
 * The version a CLI's version output reports: the first dotted version token of stdout, else of stderr. A token has an
 * optional `v` prefix and pre-release or build suffix (`v1.2.3`, `2025.08.25-896bbe1`) and adjoins no word character or dot.
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
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) return value;
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
  /** Versions observed by preflight, by executable and version arguments. */
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
        const probed = await this.probeVersion(executable, profile, environment, secrets, VERSION_TIMEOUT_MS, signal);
        if ("error" in probed) diagnostics.push({ code: "REVIEWFN_HARNESS_VERSION", level: "error", message: redactText(probed.error, secrets) });
        else version = probed.version;
      } catch (error) {
        diagnostics.push({ code: "REVIEWFN_CLI_UNAVAILABLE", level: "error", message: redactText(`The CLI executable is unavailable: ${message(error)}`, secrets) });
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
    try { executable = await this.resolveExecutable(input.configuration, input.workspace); }
    catch (error) { return state.finish("failed", `The CLI executable is unavailable: ${message(error)}`); }
    const unconfirmed = await this.confirmVersion(prepared, executable);
    if (unconfirmed) return unconfirmed;
    state.harnessVersion = this.versions.get(this.versionKey(executable, profile));
    let directory: string | undefined;
    try {
      directory = await mkdtemp(path.join(tmpdir(), "reviewfn-cli-"));
      return await this.attempts({ ...prepared, executable, directory });
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
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
  private async confirmVersion(run: Prepared, executable: string): Promise<SlotHarnessOutput | undefined> {
    if (this.versions.has(this.versionKey(executable, run.profile))) return undefined;
    const timeoutMs = Math.max(1, Math.min(VERSION_TIMEOUT_MS, run.deadline - Date.now()));
    const probed = await this.probeVersion(executable, run.profile, run.environment, run.secrets, timeoutMs, run.input.signal);
    if (run.input.signal?.aborted) return run.state.finish("canceled", "The CLI run was canceled while its version was read.");
    if (!("error" in probed)) return undefined;
    return run.state.finish(probed.timedOut ? "timed_out" : "failed", probed.error);
  }

  /** The first attempt and, when its answer is rejected, the one repair attempt. */
  private async attempts(prepared: Prepared & { executable: string; directory: string }): Promise<SlotHarnessOutput> {
    const { state, input, profile } = prepared;
    // The CLI is shown (in the prompt and {schemaFile}) a schema that also declares its json-path model report, so a CLI
    // that enforces the schema can still emit it; its answer is validated against the slot's own schema once that
    // report field is removed.
    const cliSchema = withModelReportField(prepared.schema, profile.modelReport);
    const basePrompt = `${input.prompt}\n\n${outputContract(cliSchema, profile)}`;
    const run: AttemptContext = { ...prepared, promptFile: path.join(prepared.directory, "prompt.md"), schemaFile: path.join(prepared.directory, "schema.json") };
    await writeFile(run.schemaFile, JSON.stringify(cliSchema), { mode: 0o600, flag: "wx" });
    // Every promptVia × outputVia combination allows the re-run: each attempt is a new process with a new prompt (on
    // stdin or a rewritten prompt file) and a fresh output (a new output file or its own stdout).
    let prompt = basePrompt;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const outcome = await this.attempt(run, attempt, prompt);
      if (!("errors" in outcome)) return outcome;
      state.push("warning", { attempt, message: "The CLI output did not match the output schema." });
      if (attempt === 2) return state.finish("malformed", `The CLI output did not match the output schema after one repair attempt: ${outcome.errors.slice(0, 20).join("; ")}`);
      prompt = repairPrompt(basePrompt, outcome.errors, outcome.rejected);
    }
    return state.finish("malformed", "The CLI produced no structured output.");
  }

  /** One CLI process: its terminal outcome, or the rejection that earns the repair attempt. */
  private async attempt(run: AttemptContext, attempt: number, prompt: string): Promise<SlotHarnessOutput | Rejection> {
    const { state, input, profile } = run;
    const remaining = run.deadline - Date.now();
    if (remaining <= 0) return state.finish("timed_out", "The CLI exceeded its configured bound before the repair attempt.");
    const outputBytes = state.remainingOutputBytes();
    if (outputBytes <= 0) return state.finish("timed_out", "The CLI output used its whole byte budget before the repair attempt.");
    const outputFile = path.join(run.directory, `output-${attempt}.json`);
    await writeFile(run.promptFile, prompt, { mode: 0o600 });
    const args = cliArguments(profile.argv, { promptFile: run.promptFile, schemaFile: run.schemaFile, outputFile, workspace: input.workspace, model: input.configuration.inference.model });
    state.push("started", { attempt, promptVia: profile.promptVia, outputVia: profile.outputVia, sandbox: profile.capabilities.sandbox });
    // An output file is measured while the CLI runs: one that outgrows the remaining budget aborts the run, which
    // kills the whole process group, and the run ends timed_out like any other overrun, never canceled.
    const watch = profile.outputVia === "file" ? watchOutputFile(outputFile, outputBytes, input.signal) : undefined;
    let result: CommandResult;
    try { result = await this.runner(run.executable, args, { cwd: input.workspace, env: run.environment, timeoutMs: remaining, maxOutputBytes: outputBytes, signal: watch?.signal ?? input.signal, stdin: profile.promptVia === "stdin" ? prompt : "" }); }
    catch (error) { return state.finish(input.signal?.aborted ? "canceled" : "failed", `The CLI could not be started: ${message(error)}`); }
    finally { watch?.stop(); }
    state.record(result);
    // Every model report is read from what this attempt left, within the output budget, before any terminal return:
    // a run that served another model is void whether it then completed, failed, hung or overran its bounds.
    const unreported = await reportStderrModel(run, result.stderr);
    if (unreported) return unreported;
    const output = await readAnswer(run, outputFile, result.stdout);
    return terminalOutcome(run, attempt, result, output, watch?.overrun()) ?? accept(run, attempt, output);
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
   * resolved through every link and refused when it lands in the working directory or the review workspace, or is a
   * world-writable file, so the repository under review can never supply the CLI that runs with the credentials.
   */
  private async resolveExecutable(config: ReviewFnConfig, workspace?: string): Promise<string> {
    const configured = config.harness.executable ?? this.executable ?? "";
    if (!path.isAbsolute(configured) && /[\\/]/.test(configured)) throw new Error("harness.executable must be an absolute path or a bare command name, never a relative path.");
    const executable = await realpath(path.isAbsolute(configured) ? configured : await resolveTrustedExecutable(configured, this.environment.PATH ?? ""));
    for (const root of [process.cwd(), ...(workspace === undefined ? [] : [workspace])]) {
      const canonical = await realpath(root);
      if (executable === canonical || executable.startsWith(`${canonical}${path.sep}`)) throw new Error(`harness.executable resolves to ${executable}, inside the repository under review, which may not supply the CLI.`);
    }
    const file = await stat(executable);
    const windows = process.platform === "win32";
    if (!file.isFile() || !windows && (file.mode & 0o002) !== 0) throw new Error(`harness.executable resolves to ${executable}, which is not a regular file that only trusted users can change.`);
    await access(executable, windows ? constants.F_OK : constants.X_OK);
    return executable;
  }

  private versionKey(executable: string, profile: HarnessProfile): string {
    return JSON.stringify([executable, profile.versionArgv ?? CLI_DEFAULT_VERSION_ARGV]);
  }

  /**
   * Run the version arguments outside the workspace with the profile's environment and record the reported version. A
   * failure's detail is redacted before it is cut to length, so a secret that crosses the cut cannot leak its prefix. A
   * probe that hangs or overruns its output bound says so, so the run can end timed_out.
   */
  private async probeVersion(executable: string, profile: HarnessProfile, environment: NodeJS.ProcessEnv, secrets: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ version: string } | { error: string; timedOut: boolean }> {
    const args = [...(profile.versionArgv ?? CLI_DEFAULT_VERSION_ARGV)];
    let result: CommandResult;
    try { result = await this.runner(executable, args, { cwd: tmpdir(), env: environment, timeoutMs, maxOutputBytes: VERSION_OUTPUT_BYTES, signal }); }
    catch (error) { return { error: redactText(`The CLI version could not be read: ${message(error)}`, secrets), timedOut: false }; }
    if (result.timedOut) return { error: `The CLI version command exceeded its ${timeoutMs} ms or ${VERSION_OUTPUT_BYTES}-byte bound.`, timedOut: true };
    if (result.code !== 0) return { error: `The CLI version command exited with ${String(result.code ?? result.signal)}: ${redactText(result.stderr, secrets).trim().slice(0, 500)}`, timedOut: false };
    const version = parseCliVersion(result.stdout, result.stderr);
    if (!version) return { error: "The CLI reported no recognizable version, so the slot's pinned version cannot be confirmed.", timedOut: false };
    this.versions.set(this.versionKey(executable, profile), version);
    return { version };
  }

  private secrets(config: ReviewFnConfig, environment: NodeJS.ProcessEnv): string[] {
    const credential = config.inference.credentialEnv ? this.environment[config.inference.credentialEnv] : undefined;
    // The credential, and every allowlisted value whose name marks it as a secret.
    return collectSecrets(environment, credential ? [credential] : []);
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

interface AttemptContext extends Prepared { executable: string; directory: string; promptFile: string; schemaFile: string }

/** An answer rejected by validation, with what the repair prompt echoes back. */
interface Rejection { errors: string[]; rejected: string | undefined }

type OutputRead = { value: Record<string, unknown>; text?: string } | { error: string; text?: string } | { overrun: string };

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

/** Read a `stderr-regex` model report, bounded in time: a reporter that cannot finish ends the run timed_out (or canceled). */
async function reportStderrModel(run: AttemptContext, stderr: string): Promise<SlotHarnessOutput | undefined> {
  if (!run.profile.modelReport.startsWith("stderr-regex:")) return undefined;
  const matched = await matchReporter(stderr, run.profile.modelReport.slice("stderr-regex:".length), MODEL_REPORT_TIMEOUT_MS, run.input.signal);
  if ("values" in matched) {
    for (const value of matched.values) run.state.note(value);
    return undefined;
  }
  return run.state.finish(matched.terminal, matched.reason);
}

/**
 * Every capture of a `stderr-regex` reporter in `text`, matched in a worker thread: a pattern that backtracks without
 * end is terminated after `timeoutMs`, or `MODEL_REPORT_ABORT_GRACE_MS` after `signal` aborts, instead of blocking the
 * event loop. The grace lets a CLI that the panel stopped at its deadline still have its report read.
 */
export function matchReporter(text: string, source: string, timeoutMs: number, signal?: AbortSignal): Promise<{ values: unknown[] } | { terminal: "timed_out" | "canceled" | "failed"; reason: string }> {
  return new Promise(resolve => {
    const worker = new Worker(REPORTER_WORKER, { eval: true, workerData: { text, source } });
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const end = (outcome: { values: unknown[] } | { terminal: "timed_out" | "canceled" | "failed"; reason: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      resolve(outcome);
    };
    const onAbort = () => { grace = setTimeout(() => end({ terminal: "canceled", reason: "The CLI run was canceled while its model report was read." }), MODEL_REPORT_ABORT_GRACE_MS); };
    const timer = setTimeout(() => end({ terminal: "timed_out", reason: `The model reporter did not finish within ${timeoutMs} ms, so the served model was not read.` }), timeoutMs);
    worker.once("message", (values: unknown[]) => end({ values }));
    worker.once("error", error => end({ terminal: "failed", reason: `The model reporter failed: ${message(error)}` }));
    worker.once("exit", () => end({ terminal: "failed", reason: "The model reporter stopped without a result." }));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const REPORTER_WORKER = `const { parentPort, workerData } = require("node:worker_threads");
const values = [];
for (const match of workerData.text.matchAll(new RegExp(workerData.source, "gu"))) values.push(match[1]);
parentPort.postMessage(values);`;

/** The attempt's answer, with its `json-path` model report read and, unless the slot's schema declares it, removed. */
async function readAnswer(run: AttemptContext, outputFile: string, stdout: string): Promise<OutputRead> {
  const output = run.profile.outputVia === "file" ? await readOutputFile(outputFile, run.state.remainingOutputBytes()) : stdoutObject(stdout);
  if ("text" in output && output.text !== undefined) run.state.recordOutputFile(output.text);
  if ("value" in output && run.profile.modelReport.startsWith("json-path:")) {
    const dotted = run.profile.modelReport.slice("json-path:".length);
    run.state.note(valueAtPath(output.value, dotted));
    stripReportField(output.value, dotted, run.schema);
  }
  return output;
}

/**
 * The attempt's terminal outcome before its answer is judged, in one precedence: a caller's cancellation; then any
 * overrun of the time or output bound, whether the watcher, the runner or the output read found it; then a reported
 * model mismatch; then a nonzero exit (quota_exhausted when stderr says so). A file overrun is never classified by the
 * exit that followed it.
 */
function terminalOutcome(run: AttemptContext, attempt: number, result: CommandResult, output: OutputRead, fileOverrun: string | undefined): SlotHarnessOutput | undefined {
  const { state } = run;
  if (result.canceled && (fileOverrun === undefined || run.input.signal?.aborted)) return state.finish("canceled", "The CLI run was canceled.");
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

/** The completed run for an answer that validates and confirms its model, or the rejection that earns a repair. */
function accept(run: AttemptContext, attempt: number, output: OutputRead): SlotHarnessOutput | Rejection {
  if (!("value" in output)) return { errors: ["error" in output ? output.error : "The CLI produced no answer."], rejected: "text" in output ? output.text : undefined };
  const errors = run.validate(output.value);
  const payload = normalizePayload(output.value);
  if (!errors.length) errors.push(...validateHarnessPayload(payload));
  if (errors.length) return { errors, rejected: JSON.stringify(output.value) };
  // Only an answer that would be accepted must confirm its model; an invalid one still gets its repair attempt.
  const unconfirmed = run.state.unconfirmedModel();
  if (unconfirmed) return run.state.finish("failed", unconfirmed);
  run.state.push("completed", { attempt });
  return run.state.complete(redactJson(payload, run.secrets));
}

/** The last JSON object line of stdout. */
function stdoutObject(stdout: string): OutputRead {
  const value = lastJsonObjectLine(stdout);
  return value ? { value } : { error: "No stdout line parses as a JSON object." };
}
/** The output file, read without following a link, within the remaining output budget, as exactly one JSON object. */
async function readOutputFile(file: string, maxBytes: number): Promise<OutputRead> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { return { error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "The CLI wrote no output file." : `The output file could not be opened: ${message(error)}` }; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { error: "The output file is not a regular file." };
    if (stat.size > maxBytes) return { overrun: `The CLI output file (${stat.size} bytes) exceeded the remaining ${Math.max(0, maxBytes)}-byte output budget.` };
    const buffer = Buffer.alloc(Math.max(0, maxBytes) + 1);
    let length = 0;
    for (let count = -1; count !== 0 && length < buffer.length;) { count = (await handle.read(buffer, length, buffer.length - length, null)).bytesRead; length += count; }
    if (length > maxBytes) return { overrun: `The CLI output file exceeded the remaining ${maxBytes}-byte output budget.` };
    const text = buffer.subarray(0, length).toString("utf8");
    try {
      const value: unknown = JSON.parse(text);
      if (isRecord(value)) return { value, text };
    } catch { /* reported below */ }
    return { error: "The output file is not exactly one JSON object.", text };
  } finally { await handle.close(); }
}

/**
 * Measure a running CLI's output file (without following a link) against the output budget, and abort the returned
 * signal, which also follows the caller's, once the file outgrows it.
 */
function watchOutputFile(file: string, maxBytes: number, parent: AbortSignal | undefined): { signal: AbortSignal; stop: () => void; overrun: () => string | undefined } {
  const controller = new AbortController();
  let overrun: string | undefined;
  let checking = false;
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    lstat(file).then(stat => {
      if (stat.size > maxBytes && !controller.signal.aborted) {
        overrun = `The CLI output file grew past the remaining ${Math.max(0, maxBytes)}-byte output budget (${stat.size} bytes) while it ran.`;
        controller.abort();
      }
    }, () => { /* not written yet */ }).finally(() => { checking = false; });
  }, OUTPUT_FILE_POLL_MS);
  timer.unref();
  return {
    signal: controller.signal,
    stop: () => { clearInterval(timer); parent?.removeEventListener("abort", onParentAbort); },
    overrun: () => overrun,
  };
}

/**
 * The schema shown to the CLI: the slot's schema with the path a `json-path` model report reads declared, as a required
 * string, wherever the schema leaves it undeclared. It descends through the object and array schemas the slot already
 * declares on that path (making each step required), so a CLI that enforces a closed schema, even a closed nested
 * object, can still report its model. Declared siblings are kept, the caller's schema is never changed, and a step with
 * no declared properties or items is shown unchanged.
 */
export function withModelReportField(schema: Readonly<Record<string, unknown>>, modelReport: string): Readonly<Record<string, unknown>> {
  if (!modelReport.startsWith("json-path:")) return schema;
  return declarePath(schema, modelReport.slice("json-path:".length).split("."));
}

function declarePath(schema: Readonly<Record<string, unknown>>, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const [key, ...rest] = keys;
  if (key === undefined) return schema;
  if (/^\d+$/.test(key)) {
    if (!isRecord(schema.items)) return schema;
    const items = declarePath(schema.items, rest);
    return items === schema.items ? schema : { ...schema, items };
  }
  const properties = schema.properties;
  if (!isRecord(properties)) return schema;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const withKey = required.includes(key) ? required : [...required, key];
  if (!Object.hasOwn(properties, key)) return { ...schema, properties: { ...properties, [key]: reportField(rest) }, required: withKey };
  const declared = properties[key];
  if (!isRecord(declared)) return schema;
  const child = declarePath(declared, rest);
  return child === declared ? schema : { ...schema, properties: { ...properties, [key]: child }, required: withKey };
}

/** A required string at the remaining dotted path, through new objects and arrays. */
function reportField(keys: readonly string[]): Record<string, unknown> {
  let field: Record<string, unknown> = { type: "string" };
  for (const key of [...keys].reverse()) {
    field = /^\d+$/.test(key) ? { type: "array", minItems: Number(key) + 1, items: field } : { type: "object", properties: { [key]: field }, required: [key] };
  }
  return field;
}

/**
 * Remove the part of a `json-path` model report the output schema does not declare: the first key on the dotted path
 * that its object schema leaves undeclared, at whatever depth, so a CLI may report its model inside a closed answer
 * without failing the slot's schema. A report field the schema declares is kept and validated like any other.
 */
function stripReportField(value: Record<string, unknown>, dotted: string, schema: Readonly<Record<string, unknown>>): void {
  let node: unknown = value;
  let declared: unknown = schema;
  for (const key of dotted.split(".")) {
    if (Array.isArray(node) && /^\d+$/.test(key)) {
      node = node[Number(key)];
      declared = isRecord(declared) ? declared.items : undefined;
      continue;
    }
    if (!isRecord(node) || !Object.hasOwn(node, key)) return;
    const properties = isRecord(declared) ? declared.properties : undefined;
    if (!isRecord(properties) || !Object.hasOwn(properties, key)) {
      delete node[key];
      return;
    }
    node = node[key];
    declared = properties[key];
  }
}

function outputContract(schema: Readonly<Record<string, unknown>>, profile: HarnessProfile): string {
  const lastLine = profile.outputVia === "stdout-last-json" ? "\nPrint the object on a single line, as the last line of your output." : "";
  return `Output contract: your final answer must be exactly one JSON object, with no prose and no code fence, that validates against this JSON Schema:\n${JSON.stringify(schema)}${lastLine}`;
}

/** The base prompt again, with the rejected answer (cut to its first bytes) and why it was rejected. */
function repairPrompt(basePrompt: string, errors: readonly string[], previous: string | undefined): string {
  const listed = errors.slice(0, 50).map(error => `- ${error}`).join("\n");
  const echoed = previous === undefined ? "(no JSON object was found)" : Buffer.from(previous, "utf8").subarray(0, REPAIR_ECHO_BYTES).toString("utf8");
  const sections = [basePrompt, "Repair: your previous answer was rejected and this is the only repair attempt."];
  sections.push(`Validation errors:\n${listed}`, `Previous answer (at most ${REPAIR_ECHO_BYTES} bytes):\n${echoed}`);
  sections.push("Reply with exactly one JSON object that validates against the schema above.");
  return sections.join("\n\n");
}

type Payload = Omit<HarnessOutput, "terminal" | "events" | "transcript">;

/** A caller-schema-valid output as a 0.1 harness payload, as the other adapters convert it. */
function normalizePayload(value: Record<string, unknown>): Payload {
  const { requirements = [], assessments = [], evidence, findings, inspectedPaths, uninspected } = value as Partial<HarnessOutput>;
  return omitOptionalNulls({ requirements, assessments, evidence, findings, inspectedPaths, uninspected }) as Payload;
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

  public record(result: CommandResult): void {
    this.reported = undefined;
    this.rawBytes += Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    this.transcript.push(redactText(`${result.stdout}\n${result.stderr}`, this.secrets));
  }

  public recordOutputFile(text: string): void {
    this.rawBytes += Buffer.byteLength(text);
    this.transcript.push(redactText(text, this.secrets));
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
    const redacted = redactText(value, this.secrets);
    return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
  }

  public complete(payload: Payload): SlotHarnessOutput {
    return this.bounded({ terminal: "completed", ...payload, events: [] });
  }

  public finish(terminal: HarnessOutput["terminal"], reason: string): SlotHarnessOutput {
    return this.bounded(failure(terminal, redactText(reason, this.secrets)));
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
    const telemetry = { events: redactJson(this.events, this.secrets), transcript: this.transcript.join("\n"), observed: this.observation() };
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
