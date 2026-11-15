import { constants } from "node:fs";
import { access, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUOTA = /quota|rate.?limit|usage.?limit|credit balance|too many requests/i;
/** The first dotted version token, with an optional `v` prefix and pre-release or build suffix (`v1.2.3`, `2025.08.25-896bbe1`). */
const VERSION = /(?:^|[^\w.])v?(\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]*[0-9A-Za-z])?)(?![\w.])/;

/** The version a CLI's version output reports: the first dotted version token of stdout, else of stderr. */
export function parseCliVersion(stdout: string, stderr = ""): string | undefined {
  return VERSION.exec(` ${stdout}`)?.[1] ?? VERSION.exec(` ${stderr}`)?.[1];
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
        const probed = await this.probeVersion(executable, profile, environment, VERSION_TIMEOUT_MS, signal);
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
    const config = input.configuration;
    if (input.change.pullRequest !== undefined) return failure("failed", "The generic CLI harness serves only trusted local reviews: pull-request review is refused because it enforces no tool restriction of its own.");
    const refused = this.configurationDiagnostics(config).find(item => item.level === "error");
    if (refused) return failure("failed", refused.message);
    const profile = config.harness.profileDefinition!;
    if (!path.isAbsolute(input.workspace)) return failure("failed", "The review workspace must be an absolute path.");
    const schema = input.outputSchema ?? harnessOutputSchema;
    let validate: (value: unknown) => string[];
    try { validate = input.outputSchema ? structuredOutputValidator(input.outputSchema) : validateHarnessPayload; }
    catch (error) { return failure("failed", `outputSchema is not a valid JSON Schema: ${message(error)}`); }
    const environment = cliEnvironment(this.environment, profile.envAllowlist, config.inference.credentialEnv);
    const secrets = this.secrets(config, environment);
    const state = new RunState(config.inference.model, profile, secrets, input.policy.limits.maxOutputBytes);
    const deadline = Date.now() + input.policy.limits.harnessTimeoutMs;
    let executable: string;
    try { executable = await this.resolveExecutable(config); }
    catch (error) { return state.finish("failed", `The CLI executable is unavailable: ${message(error)}`); }
    const versionKey = this.versionKey(executable, profile);
    if (!this.versions.has(versionKey)) {
      const probed = await this.probeVersion(executable, profile, environment, Math.max(1, Math.min(VERSION_TIMEOUT_MS, deadline - Date.now())), input.signal);
      if (input.signal?.aborted) return state.finish("canceled", "The CLI run was canceled while its version was read.");
      if ("error" in probed) return state.finish("failed", probed.error);
    }
    state.harnessVersion = this.versions.get(versionKey);
    const basePrompt = `${input.prompt}\n\n${outputContract(schema, profile)}`;
    let prompt = basePrompt;
    let directory: string | undefined;
    try {
      directory = await mkdtemp(path.join(tmpdir(), "reviewfn-cli-"));
      const promptFile = path.join(directory, "prompt.md");
      const schemaFile = path.join(directory, "schema.json");
      await writeFile(schemaFile, JSON.stringify(schema), { mode: 0o600, flag: "wx" });
      // Every promptVia × outputVia combination allows the re-run: each attempt is a new process with a new prompt (on
      // stdin or a rewritten prompt file) and a fresh output (a new output file or its own stdout).
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return state.finish("timed_out", "The CLI exceeded its configured bound before the repair attempt.");
        const outputBytes = state.remainingOutputBytes();
        if (outputBytes <= 0) return state.finish("timed_out", "The CLI output used its whole byte budget before the repair attempt.");
        const outputFile = path.join(directory, `output-${attempt}.json`);
        await writeFile(promptFile, prompt, { mode: 0o600 });
        const args = cliArguments(profile.argv, { promptFile, schemaFile, outputFile, workspace: input.workspace, model: config.inference.model });
        state.push("started", { attempt, promptVia: profile.promptVia, outputVia: profile.outputVia, sandbox: profile.capabilities.sandbox });
        let result: CommandResult;
        try { result = await this.runner(executable, args, { cwd: input.workspace, env: environment, timeoutMs: remaining, maxOutputBytes: outputBytes, signal: input.signal, stdin: profile.promptVia === "stdin" ? prompt : "" }); }
        catch (error) { return state.finish(input.signal?.aborted ? "canceled" : "failed", `The CLI could not be started: ${message(error)}`); }
        state.record(result);
        // Every model report is read from what this attempt left, within the output budget, before any terminal return:
        // a run that served another model is void whether it then completed, failed, hung or overran its bounds.
        if (profile.modelReport.startsWith("stderr-regex:")) state.reportStderr(result.stderr, profile.modelReport.slice("stderr-regex:".length));
        const output = profile.outputVia === "file" ? await readOutputFile(outputFile, state.remainingOutputBytes()) : stdoutObject(result.stdout);
        if ("text" in output && output.text !== undefined) state.recordOutputFile(output.text);
        if ("value" in output && profile.modelReport.startsWith("json-path:")) {
          const dotted = profile.modelReport.slice("json-path:".length);
          state.reportJson(valueAtPath(output.value, dotted));
          stripReportField(output.value, dotted, schema);
        }
        if (result.canceled) return state.finish("canceled", "The CLI run was canceled.");
        if (result.timedOut) return state.finish("timed_out", "The CLI run exceeded its configured time or output bound.");
        const mismatch = state.mismatchReason();
        if (mismatch) return state.finish("failed", mismatch);
        if (result.code !== 0) {
          const detail = result.stderr.trim();
          state.push("error", { attempt, exitCode: result.code, signal: result.signal });
          return state.finish(QUOTA.test(detail) ? "quota_exhausted" : "failed", state.retain(detail, MAX_DETAIL_CHARS) || `The CLI exited with ${String(result.code ?? result.signal)}.`);
        }
        if ("overrun" in output) return state.finish("timed_out", output.overrun);
        let errors: string[];
        let rejected: string | undefined = "text" in output ? output.text : undefined;
        if ("error" in output) errors = [output.error];
        else {
          const value = output.value;
          rejected = JSON.stringify(value);
          errors = validate(value);
          if (!errors.length) {
            const payload = normalizePayload(value) as Omit<HarnessOutput, "terminal" | "events" | "transcript">;
            const payloadErrors = validateHarnessPayload(payload);
            if (!payloadErrors.length) {
              // Only an answer that would be accepted must confirm its model; an invalid one still gets its repair attempt.
              const unconfirmed = state.unconfirmedModel();
              if (unconfirmed) return state.finish("failed", unconfirmed);
              state.push("completed", { attempt });
              return state.complete(redactJson(payload, secrets));
            }
            errors.push(...payloadErrors);
          }
        }
        state.push("warning", { attempt, message: "The CLI output did not match the output schema." });
        if (attempt === 2) return state.finish("malformed", `The CLI output did not match the output schema after one repair attempt: ${errors.slice(0, 20).join("; ")}`);
        prompt = repairPrompt(basePrompt, errors, rejected);
      }
      return state.finish("malformed", "The CLI produced no structured output.");
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  /** Configuration errors that refuse both preflight and run before any process starts. */
  private configurationDiagnostics(config: ReviewFnConfig): PreflightDiagnostic[] {
    const diagnostics: PreflightDiagnostic[] = [];
    const error = (code: string, text: string) => diagnostics.push({ code, level: "error", message: text });
    if (config.harness.adapter !== this.capabilities.id) error("REVIEWFN_HARNESS_MISMATCH", `Configured harness ${config.harness.adapter} does not match cli.`);
    if (config.harness.version !== CLI_HARNESS_CONTRACT_VERSION) error("REVIEWFN_HARNESS_VERSION", `Only cli adapter contract version ${CLI_HARNESS_CONTRACT_VERSION} is supported.`);
    const profile = config.harness.profileDefinition;
    if (!profile) error("REVIEWFN_HARNESS_PROFILE_REQUIRED", "The cli harness runs only panel slots whose harness.profile names a profile of the trusted panel policy.");
    else {
      const issues = validateHarnessProfile(profile).issues;
      if (issues.length) error("REVIEWFN_HARNESS_PROFILE_INVALID", `Profile ${String(config.harness.profile)} is invalid: ${issues.map(issue => `${issue.path || "/"} ${issue.message}`).join("; ")}`);
      else {
        const model = config.inference.model;
        if (profile.argv.includes("{model}") && model === "configured") error("REVIEWFN_MODEL_REQUIRED", "The profile passes {model} to the CLI, so the slot must name an explicit model.");
        if (model.startsWith("-") || /[\r\n\0]/.test(model)) error("REVIEWFN_MODEL_INVALID", "The model may not start with '-' or contain line breaks or NUL, so it can never read as a CLI option.");
      }
    }
    if (!(config.harness.executable ?? this.executable)) error("REVIEWFN_CLI_EXECUTABLE_REQUIRED", "The cli harness needs an executable: set the slot's harness.executable.");
    const credential = config.inference.credentialEnv;
    if (credential !== undefined && !ENV_NAME.test(credential)) error("REVIEWFN_CREDENTIAL_INVALID", "credentialEnv must name an environment variable.");
    else if (credential && !this.environment[credential]) error("REVIEWFN_CREDENTIAL_MISSING", `credentialEnv ${credential} is not populated.`);
    return diagnostics;
  }

  /**
   * The executable as an absolute path: an absolute path as configured, or a bare name found on the adapter's PATH in a
   * trusted directory (never the review workspace). A relative path is refused, because it would resolve inside the
   * repository under review.
   */
  private async resolveExecutable(config: ReviewFnConfig): Promise<string> {
    const executable = config.harness.executable ?? this.executable ?? "";
    if (path.isAbsolute(executable)) { await access(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK); return executable; }
    if (/[\\/]/.test(executable)) throw new Error("harness.executable must be an absolute path or a bare command name, never a relative path.");
    return resolveTrustedExecutable(executable, this.environment.PATH ?? "");
  }

  private versionKey(executable: string, profile: HarnessProfile): string {
    return JSON.stringify([executable, profile.versionArgv ?? CLI_DEFAULT_VERSION_ARGV]);
  }

  /** Run the version arguments outside the workspace with the profile's environment and record the reported version. */
  private async probeVersion(executable: string, profile: HarnessProfile, environment: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<{ version: string } | { error: string }> {
    const args = [...(profile.versionArgv ?? CLI_DEFAULT_VERSION_ARGV)];
    let result: CommandResult;
    try { result = await this.runner(executable, args, { cwd: tmpdir(), env: environment, timeoutMs, maxOutputBytes: VERSION_OUTPUT_BYTES, signal }); }
    catch (error) { return { error: `The CLI version could not be read: ${message(error)}` }; }
    if (result.code !== 0) return { error: `The CLI version command exited with ${String(result.code ?? result.signal)}${result.timedOut ? " (timed out)" : ""}: ${result.stderr.trim().slice(0, 500)}` };
    const version = parseCliVersion(result.stdout, result.stderr);
    if (!version) return { error: "The CLI reported no recognizable version, so the slot's pinned version cannot be confirmed." };
    this.versions.set(this.versionKey(executable, profile), version);
    return { version };
  }

  private secrets(config: ReviewFnConfig, environment: NodeJS.ProcessEnv): string[] {
    const credential = config.inference.credentialEnv ? this.environment[config.inference.credentialEnv] : undefined;
    // The credential, and every allowlisted value whose name marks it as a secret.
    return collectSecrets(environment, credential ? [credential] : []);
  }
}

type OutputRead = { value: Record<string, unknown>; text?: string } | { error: string; text?: string } | { overrun: string };

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
 * Remove the top-level property a `json-path` model report reads, unless the output schema declares it, so a CLI may
 * report its model next to the answer without failing a closed output schema.
 */
function stripReportField(value: Record<string, unknown>, dotted: string, schema: Readonly<Record<string, unknown>>): void {
  const top = dotted.split(".")[0];
  const declared = isRecord(schema.properties) && Object.hasOwn(schema.properties, top);
  if (!declared) delete value[top];
}

function outputContract(schema: Readonly<Record<string, unknown>>, profile: HarnessProfile): string {
  return [
    "Output contract: your final answer must be exactly one JSON object, with no prose and no code fence, that validates against this JSON Schema:",
    JSON.stringify(schema),
    ...(profile.outputVia === "stdout-last-json" ? ["Print the object on a single line, as the last line of your output."] : []),
  ].join("\n");
}

function repairPrompt(basePrompt: string, errors: readonly string[], previous: string | undefined): string {
  const echoed = previous === undefined ? "(no JSON object was found)" : Buffer.from(previous, "utf8").subarray(0, REPAIR_ECHO_BYTES).toString("utf8");
  return [
    basePrompt,
    "Repair: your previous answer was rejected and this is the only repair attempt.",
    `Validation errors:\n${errors.slice(0, 50).map(error => `- ${error}`).join("\n")}`,
    `Previous answer (at most ${REPAIR_ECHO_BYTES} bytes):\n${echoed}`,
    "Reply with exactly one JSON object that validates against the schema above.",
  ].join("\n\n");
}

/** A caller-schema-valid output as a 0.1 harness payload, as the other adapters convert it. */
function normalizePayload(value: unknown): unknown {
  const fields = value as Partial<HarnessOutput>;
  return omitOptionalNulls({ requirements: fields.requirements ?? [], assessments: fields.assessments ?? [], evidence: fields.evidence, findings: fields.findings, inspectedPaths: fields.inspectedPaths, uninspected: fields.uninspected });
}

function failure(terminal: HarnessOutput["terminal"], error: string): SlotHarnessOutput {
  return { terminal, requirements: [], assessments: [], evidence: [], findings: [], inspectedPaths: [], uninspected: [{ scope: "review", reason: error }], events: [], error };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Everything observed across a run's attempts: events, the redacted transcript, the reported models and the byte budget. */
class RunState {
  public harnessVersion: string | undefined;
  private readonly events: NormalizedRunEvent[] = [];
  private readonly transcript: string[] = [];
  /** Raw bytes counted against the output budget: stdout and stderr as the runner capped them, and each output file read. */
  private rawBytes = 0;
  /** The first reported model that is not the configured one, as stored; any one voids the run. */
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

  /** Every match of the reporter's capture group in stderr is a reported model. */
  public reportStderr(stderr: string, source: string): void {
    for (const match of stderr.matchAll(new RegExp(source, "gu"))) this.note(match[1]);
  }

  public reportJson(value: unknown): void { this.note(value); }

  public mismatchReason(): string | undefined {
    return this.mismatch === undefined ? undefined : `model_mismatch: the CLI reported model ${this.mismatch}, not the configured ${this.model}.`;
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

  public complete(payload: Omit<HarnessOutput, "terminal" | "events" | "transcript">): SlotHarnessOutput {
    return this.stored({ terminal: "completed", ...payload, ...this.outputs() });
  }

  public finish(terminal: HarnessOutput["terminal"], reason: string): SlotHarnessOutput {
    return this.stored({ ...failure(terminal, redactText(reason, this.secrets)), ...this.outputs() });
  }

  public push(type: NormalizedRunEvent["type"], data: Record<string, JsonValue>): void {
    if (this.events.length >= MAX_EVENTS) return;
    this.events.push({ sequence: this.events.length, at: new Date().toISOString(), type, data });
  }

  private note(value: unknown): void {
    if (typeof value !== "string" || !value.trim()) return;
    const stored = this.retain(value, MAX_MODEL_CHARS);
    this.reported = stored;
    this.everReported ??= stored;
    if (this.mismatch === undefined && this.model !== "configured" && value !== this.model) this.mismatch = stored;
  }

  /** The output as returned, held to the limit the panel applies to each channel, as the other adapters do. */
  private stored(output: SlotHarnessOutput): SlotHarnessOutput {
    if (output.terminal === "canceled") return output;
    const transcriptBytes = Buffer.byteLength(output.transcript ?? "");
    const eventBytes = Buffer.byteLength(JSON.stringify(output.events));
    if (transcriptBytes <= this.maxOutputBytes && eventBytes <= this.maxOutputBytes) return output;
    const reason = `The CLI output exceeded its ${this.maxOutputBytes}-byte budget once stored (transcript ${transcriptBytes} bytes, events ${eventBytes} bytes).`;
    return { ...failure("timed_out", reason), events: output.events, transcript: output.transcript, observed: output.observed };
  }

  private outputs(): Pick<SlotHarnessOutput, "events" | "transcript" | "observed"> {
    return { events: redactJson(this.events, this.secrets), transcript: this.transcript.join("\n"), observed: this.observation() };
  }

  private observation(): SlotObservation {
    const observed: SlotObservation = {};
    if (this.harnessVersion) observed.harnessVersion = this.harnessVersion;
    // A reported model that matches is the configured model; any other is reported as served, which voids the run.
    if (this.profile.modelReport !== "none") {
      if (this.mismatch !== undefined) observed.model = this.mismatch;
      else if (this.everReported !== undefined) observed.model = this.model === "configured" ? this.everReported : this.model;
    }
    const limitations: SlotRunLimitation[] = [];
    if (this.profile.modelReport === "none") limitations.push("model_unverified");
    if (this.profile.capabilities.sandbox === "tree-verified-only") limitations.push("sandbox_tree_verified_only");
    if (limitations.length) observed.limitations = limitations;
    return observed;
  }
}
