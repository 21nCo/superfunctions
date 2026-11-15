import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  harnessOutputSchema, omitOptionalNulls, redactJson, redactText, runProcessGroup, structuredOutputValidator, validateHarnessPayload,
  type CommandResult, type CommandRunner, type HarnessAdapter, type HarnessCapabilities, type HarnessOutput, type JsonValue,
  type NormalizedRunEvent, type PreflightDiagnostic, type PreflightResult, type ReviewFnConfig, type SlotHarnessInput,
  type SlotHarnessOutput, type SlotObservation,
} from "@superfunctions/reviewfn-core";

export type { CommandResult, CommandRunner } from "@superfunctions/reviewfn-core";

/**
 * The oldest supported Claude Code release: print mode supports every flag in `claudeCodeArguments`, and excluding
 * every settings source isolates the run. 2.1.211 stopped nested and path-scoped `.claude/rules` loading when project
 * settings are excluded, and 2.1.314 stopped an excluded settings file supplying settings such as auto mode rules and
 * saved permission consents.
 */
export const CLAUDE_CODE_MIN_VERSION = "2.1.314";
/** The only tools a review may use. Any other tool-use event voids the slot (`disallowed_tool_use`). */
export const CLAUDE_CODE_ALLOWED_TOOLS: readonly string[] = Object.freeze(["Read", "Grep", "Glob"]);
/** Tools that are denied explicitly, in addition to being absent from the allowlist. */
export const CLAUDE_CODE_DISALLOWED_TOOLS: readonly string[] = Object.freeze(["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"]);
const EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} });
/** Normalized events retained per run, across both attempts; the last slot records the truncation. */
const MAX_EVENTS = 10_000;
/**
 * Retention limits on stored strings (failure detail, model identity, tool name, event labels) and on the usage entries
 * kept in one usage event. They bound only what is stored, after redaction, and never what is checked.
 */
const MAX_DETAIL_CHARS = 4_000;
const MAX_MODEL_CHARS = 256;
const MAX_TOOL_CHARS = 128;
const MAX_LABEL_CHARS = 64;
const MAX_USAGE_MODELS = 32;
/** Bytes of the rejected answer echoed back in the repair prompt. */
const REPAIR_ECHO_BYTES = 16_384;
/** Environment names the harness environment owns; a credential may not reuse them. */
const RESERVED_ENVIRONMENT = new Set(["PATH", "HOME", "LANG", "TMPDIR"]);
const QUOTA = /quota|rate.?limit|usage.?limit|credit balance/i;
/** A model the closed rule can confirm: no bracketed context suffix such as `[1m]`, which serving model IDs omit. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The exact argv of a review: print mode with the prompt on stdin, stream-json events (which print mode emits only with
 * `--verbose`), the configured model, the read-only tool allowlist (`--tools` also removes every other built-in tool),
 * the explicit denylist, default permissions (so nothing outside the allowlist is approved), an empty strict MCP
 * configuration, no settings sources (so no user or project settings or instruction files are loaded) and no session
 * persistence.
 */
export function claudeCodeArguments(model: string): string[] {
  const allowed = CLAUDE_CODE_ALLOWED_TOOLS.join(",");
  return [
    "-p", "--output-format", "stream-json", "--verbose", "--model", model,
    "--tools", allowed, "--allowedTools", allowed, "--disallowedTools", CLAUDE_CODE_DISALLOWED_TOOLS.join(","),
    "--permission-mode", "default", "--strict-mcp-config", "--mcp-config", EMPTY_MCP_CONFIG,
    "--setting-sources", "", "--no-session-persistence",
  ];
}

/** Whether a resolved model is the configured one, optionally with a date suffix: `^<model>(-\d{8})?$`. */
export function resolvedModelMatches(configured: string, resolved: string): boolean {
  return new RegExp(`^${configured.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}(-\\d{8})?$`).test(resolved);
}

/** The `major.minor.patch` that `claude --version` reports, or undefined when it reports none. */
export function parseClaudeCodeVersion(output: string): string | undefined {
  return /(?:^|[^\d.])(\d+\.\d+\.\d+)(?![\d.])/.exec(` ${output}`)?.[1];
}

function versionAtLeast(version: string, minimum: string): boolean {
  const left = version.split(".").map(Number);
  const right = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] > right[index];
  return true;
}

export interface ClaudeCodeHarnessOptions {
  /** The `claude` executable; `harness.executable` in the run configuration overrides it. */
  executable?: string;
  runner?: CommandRunner;
  environment?: NodeJS.ProcessEnv;
}

/**
 * Claude Code CLI adapter in non-interactive print mode. It is read-only (`Read`, `Grep`, `Glob`), serves only trusted
 * local reviews, validates the final result message against the slot's output schema with one bounded repair attempt,
 * and reports the resolved model, disallowed tool use and usage it observed.
 */
export class ClaudeCodeHarnessAdapter implements HarnessAdapter {
  public readonly capabilities: HarnessCapabilities = {
    id: "claude-code",
    version: "1",
    providers: ["anthropic"],
    authModes: ["api-key", "subscription"],
    structuredOutput: true,
    observableEvents: true,
    usageMetrics: true,
    cancellation: true,
    toolControls: true,
    sandboxModes: ["read-only-tools"],
  };
  private readonly runner: CommandRunner;
  private readonly executable: string;
  private readonly environment: NodeJS.ProcessEnv;
  /** The version the last successful preflight observed, used when a stream does not report one. */
  private observedVersion: string | undefined;

  public constructor(options: ClaudeCodeHarnessOptions = {}) {
    this.runner = options.runner ?? runProcessGroup;
    this.executable = options.executable ?? "claude";
    this.environment = options.environment ?? process.env;
  }

  public async preflight(config: ReviewFnConfig, signal?: AbortSignal): Promise<PreflightResult> {
    const diagnostics = this.configurationDiagnostics(config);
    if (config.inference.auth === "api-key" || config.inference.auth === "subscription") diagnostics.push({ code: "REVIEWFN_LOCAL_TRUST_ONLY", level: "warning", message: "Claude Code runs with a direct credential: use it only for trusted local reviews without a pull-request identity." });
    let version: string | undefined;
    const home = await this.temporaryHome(config);
    try {
      const result = await this.runner(this.executableFor(config), ["--version"], { cwd: process.cwd(), env: harnessEnvironment(this.environment, config, home), timeoutMs: 10_000, maxOutputBytes: 64_000, signal })
        .catch((error: unknown): CommandResult => ({ code: null, signal: null, stdout: "", stderr: message(error), timedOut: false, canceled: false }));
      if (result.code !== 0) diagnostics.push({ code: "REVIEWFN_CLAUDE_CODE_UNAVAILABLE", level: "error", message: `Claude Code executable is unavailable: ${redactText(result.stderr.trim(), this.secrets(config)).slice(0, 500) || `exit ${String(result.code)}`}.` });
      else {
        version = parseClaudeCodeVersion(result.stdout);
        if (!version) diagnostics.push({ code: "REVIEWFN_HARNESS_VERSION", level: "error", message: `Claude Code reported no recognizable version, so the minimum ${CLAUDE_CODE_MIN_VERSION} was not confirmed.` });
        else if (!versionAtLeast(version, CLAUDE_CODE_MIN_VERSION)) diagnostics.push({ code: "REVIEWFN_HARNESS_VERSION", level: "error", message: `Claude Code ${version} is older than the minimum supported ${CLAUDE_CODE_MIN_VERSION}.` });
      }
    } finally {
      if (home) await rm(home, { recursive: true, force: true });
    }
    const ok = diagnostics.every(item => item.level !== "error");
    if (ok && version) { this.observedVersion = version; this.capabilities.version = version; }
    return { ok, resolved: ok && version ? { provider: config.inference.provider, model: config.inference.model, auth: config.inference.auth, harnessVersion: version } : undefined, diagnostics };
  }

  public async run(input: SlotHarnessInput): Promise<SlotHarnessOutput> {
    const config = input.configuration;
    if (input.change.pullRequest !== undefined) return failure("failed", "Claude Code serves only trusted local reviews: pull-request review is refused because untrusted repository content could reach the credential.");
    const refused = this.configurationDiagnostics(config).find(item => item.level === "error");
    if (refused) return failure("failed", refused.message);
    const schema = input.outputSchema ?? harnessOutputSchema;
    let validate: (value: unknown) => string[];
    try { validate = input.outputSchema ? structuredOutputValidator(input.outputSchema) : validateHarnessPayload; }
    catch (error) { return failure("failed", `outputSchema is not a valid JSON Schema: ${message(error)}`); }
    const secrets = this.secrets(config);
    const model = config.inference.model;
    const deadline = Date.now() + input.policy.limits.harnessTimeoutMs;
    const state = new RunState(model, secrets, this.observedVersion, input.policy.limits.maxOutputBytes);
    const basePrompt = `${input.prompt}\n\n${outputContract(schema)}`;
    let prompt = basePrompt;
    let home: string | undefined;
    try {
      home = await this.temporaryHome(config);
      const environment = harnessEnvironment(this.environment, config, home);
      const args = claudeCodeArguments(model);
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return state.finish("timed_out", "Claude Code exceeded its configured bound before the repair attempt.");
        // Both attempts share one output budget, as they share one transcript: the repair gets only what is left.
        const outputBytes = state.remainingOutputBytes();
        if (outputBytes <= 0) return state.finish("timed_out", "Claude Code output used its whole byte budget before the repair attempt.");
        let result: CommandResult;
        try { result = await this.runner(this.executableFor(config), args, { cwd: input.workspace, env: environment, timeoutMs: remaining, maxOutputBytes: outputBytes, signal: input.signal, stdin: prompt }); }
        catch (error) { return state.finish(input.signal?.aborted ? "canceled" : "failed", `Claude Code could not be started: ${message(error)}`); }
        const stream = state.record(result);
        if (result.canceled) return state.finish("canceled", "Claude Code run was canceled.");
        if (result.timedOut) return state.finish("timed_out", "Claude Code run exceeded its configured bound.");
        const voided = state.voidReason();
        if (voided) return state.finish("failed", voided);
        if (result.code !== 0 || stream.result?.isError) {
          const detail = [result.stderr.trim(), stream.result?.isError ? stream.result.text : ""].filter(Boolean).join("\n");
          return state.finish(QUOTA.test(detail) ? "quota_exhausted" : "failed", state.retain(detail, MAX_DETAIL_CHARS) || `Claude Code exited with ${String(result.code)}.`);
        }
        const unconfirmed = state.unconfirmedModel();
        if (unconfirmed) return state.finish("failed", unconfirmed);
        const parsed = extractObject(stream.result?.text);
        const errors = "error" in parsed ? [parsed.error] : validate(parsed.value);
        if (!errors.length && "value" in parsed) {
          const payload = normalizePayload(parsed.value) as Omit<HarnessOutput, "terminal" | "events" | "transcript">;
          const payloadErrors = validateHarnessPayload(payload);
          if (!payloadErrors.length) return state.complete(redactJson(payload, secrets));
          errors.push(...payloadErrors);
        }
        if (attempt === 2) return state.finish("malformed", `Claude Code output did not match the output schema after one repair attempt: ${errors.slice(0, 20).join("; ")}`);
        prompt = repairPrompt(basePrompt, errors, stream.result?.text);
      }
      return state.finish("malformed", "Claude Code produced no structured output.");
    } finally {
      if (home) await rm(home, { recursive: true, force: true });
    }
  }

  /** Configuration errors that refuse both preflight and run before any process starts. */
  private configurationDiagnostics(config: ReviewFnConfig): PreflightDiagnostic[] {
    const diagnostics: PreflightDiagnostic[] = [];
    if (config.harness.adapter !== this.capabilities.id) diagnostics.push({ code: "REVIEWFN_HARNESS_MISMATCH", level: "error", message: `Configured harness ${config.harness.adapter} does not match claude-code.` });
    if (config.harness.version !== "1") diagnostics.push({ code: "REVIEWFN_HARNESS_VERSION", level: "error", message: "Only Claude Code adapter contract version 1 is supported." });
    if (!this.capabilities.providers.includes(config.inference.provider)) diagnostics.push({ code: "REVIEWFN_PROVIDER_UNSUPPORTED", level: "error", message: `Provider ${config.inference.provider} is unsupported by this adapter.` });
    if (!this.capabilities.authModes.includes(config.inference.auth)) diagnostics.push({ code: "REVIEWFN_AUTH_UNSUPPORTED", level: "error", message: `Auth mode ${config.inference.auth} is unsupported by this adapter.` });
    if (config.inference.model === "configured") diagnostics.push({ code: "REVIEWFN_MODEL_REQUIRED", level: "error", message: "Select an explicit model so provenance is reproducible and the resolved model can be checked." });
    else if (!MODEL_PATTERN.test(config.inference.model)) diagnostics.push({ code: "REVIEWFN_MODEL_INVALID", level: "error", message: "The model must be a Claude model name of letters, digits, '.', '-' and '_', without a bracketed suffix such as [1m], so the served model can be confirmed." });
    const credential = config.inference.credentialEnv;
    if (credential !== undefined && (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(credential) || RESERVED_ENVIRONMENT.has(credential))) diagnostics.push({ code: "REVIEWFN_CREDENTIAL_INVALID", level: "error", message: "credentialEnv must name an environment variable other than PATH, HOME, LANG and TMPDIR." });
    else if (config.inference.auth === "api-key" && (!credential || !this.environment[credential])) diagnostics.push({ code: "REVIEWFN_CREDENTIAL_MISSING", level: "error", message: "API-key auth requires a populated credentialEnv available only to the harness process." });
    else if (credential && !this.environment[credential]) diagnostics.push({ code: "REVIEWFN_CREDENTIAL_MISSING", level: "error", message: `credentialEnv ${credential} is not populated.` });
    return diagnostics;
  }

  /** A fresh, private home for every auth mode except `subscription`, which needs the operator's signed-in home. */
  private async temporaryHome(config: ReviewFnConfig): Promise<string | undefined> {
    return config.inference.auth === "subscription" ? undefined : mkdtemp(path.join(tmpdir(), "reviewfn-claude-home-"));
  }

  private secrets(config: ReviewFnConfig): string[] {
    const credential = config.inference.credentialEnv ? this.environment[config.inference.credentialEnv] : undefined;
    return credential ? [credential] : [];
  }

  private executableFor(config: ReviewFnConfig): string { return config.harness.executable ?? this.executable; }
}

/** The harness environment allowlist: PATH, HOME (fresh unless `home` is undefined), LANG, TMPDIR and the credential. */
function harnessEnvironment(source: NodeJS.ProcessEnv, config: ReviewFnConfig, home: string | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "TMPDIR"]) if (source[key] !== undefined) environment[key] = source[key];
  if (home !== undefined) environment.HOME = home;
  else if (source.HOME !== undefined) environment.HOME = source.HOME;
  const credential = config.inference.credentialEnv;
  if (credential && !RESERVED_ENVIRONMENT.has(credential) && source[credential] !== undefined) {
    environment[credential] = source[credential];
    // Claude Code reads an API key only from ANTHROPIC_API_KEY.
    if (config.inference.auth === "api-key") environment.ANTHROPIC_API_KEY = source[credential];
  }
  return environment;
}

function outputContract(schema: Readonly<Record<string, unknown>>): string {
  return [
    "Output contract: your final message must be exactly one JSON object, with no prose and no code fence, that validates against this JSON Schema:",
    JSON.stringify(schema),
  ].join("\n");
}

function repairPrompt(basePrompt: string, errors: readonly string[], previous: string | undefined): string {
  const echoed = previous === undefined ? "(no final result message)" : Buffer.from(previous, "utf8").subarray(0, REPAIR_ECHO_BYTES).toString("utf8");
  return [
    basePrompt,
    "Repair: your previous final message was rejected and this is the only repair attempt.",
    `Validation errors:\n${errors.slice(0, 50).map(error => `- ${error}`).join("\n")}`,
    `Previous final message (at most ${REPAIR_ECHO_BYTES} bytes):\n${echoed}`,
    "Reply with exactly one JSON object that validates against the schema above.",
  ].join("\n\n");
}

/** The final result message parsed as one JSON object: the whole message, or the whole content of one code fence. */
function extractObject(text: string | undefined): { value: unknown } | { error: string } {
  if (text === undefined) return { error: "The stream ended without a final result message." };
  const trimmed = text.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  try {
    const value: unknown = JSON.parse(fenced ? fenced[1] : trimmed);
    if (value && typeof value === "object" && !Array.isArray(value)) return { value };
  } catch { /* reported below */ }
  return { error: "The final result message is not exactly one JSON object." };
}

/**
 * A caller-schema-valid output as a 0.1 harness payload, as the Codex adapter converts it: lens output has no
 * requirements or assessments, so only those default to empty; a missing required section stays missing for
 * `validateHarnessPayload` to reject; and a null the caller schema allowed is an absent value.
 */
function normalizePayload(value: unknown): unknown {
  const fields = value as Partial<HarnessOutput>;
  return omitOptionalNulls({ requirements: fields.requirements ?? [], assessments: fields.assessments ?? [], evidence: fields.evidence, findings: fields.findings, inspectedPaths: fields.inspectedPaths, uninspected: fields.uninspected });
}

function failure(terminal: HarnessOutput["terminal"], error: string): SlotHarnessOutput {
  return { terminal, requirements: [], assessments: [], evidence: [], findings: [], inspectedPaths: [], uninspected: [{ scope: "review", reason: error }], events: [], error };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const amount = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

interface StreamResult { text?: string; isError: boolean }
interface ParsedStream { result?: StreamResult }

/**
 * Everything observed across a run's attempts: retained events (no message or tool content), the redacted transcript,
 * every model and tool the stream reported, and usage. Every outcome carries the observation, so the panel voids a run
 * that used a disallowed tool or a model other than the configured one, whatever its terminal.
 */
class RunState {
  private readonly events: NormalizedRunEvent[] = [];
  private truncated = false;
  private readonly transcript: string[] = [];
  /**
   * The model check runs on every model identity any attempt names (the session's model, each assistant message's
   * model, the result's model and every usage key), in full and before any retention limit: those limits bound only
   * what is stored. `sawModel` and the first mismatch accumulate across attempts, so a mismatch in either attempt voids.
   */
  private sawModel = false;
  private mismatch: string | undefined;
  /**
   * Whether a model served the current attempt: an assistant message, a usage entry or the result's model, not the
   * session's requested model. Scoped per attempt, so a repair attempt cannot complete on the first attempt's evidence.
   */
  private served = false;
  /** Raw stdout and stderr bytes of the attempts so far, as the runner counts them against its output cap. */
  private rawBytes = 0;
  private readonly disallowed = new Set<string>();
  private harnessVersion: string | undefined;
  private inputTokens: number | undefined;
  private outputTokens: number | undefined;
  private costUsd: number | undefined;

  public constructor(private readonly model: string, private readonly secrets: readonly string[], preflightVersion: string | undefined, private readonly maxOutputBytes: number) {
    this.harnessVersion = preflightVersion;
  }

  /** Normalize one attempt's stream; the checks see every line, even after event retention is exhausted. */
  public record(result: CommandResult): ParsedStream {
    this.served = false;
    this.rawBytes += Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    this.transcript.push(redactText(`${result.stdout}\n${result.stderr}`, this.secrets));
    const parsed: ParsedStream = {};
    for (const match of result.stdout.matchAll(/[^\r\n]+/g)) {
      let raw: unknown;
      try { raw = JSON.parse(match[0]); } catch { this.push("warning", { message: "Unparseable Claude Code event was discarded." }); continue; }
      if (!isRecord(raw)) { this.push("warning", { message: "Non-object Claude Code event was discarded." }); continue; }
      const type = typeof raw.type === "string" ? raw.type : "unknown";
      if (type === "system") this.system(raw);
      else if (type === "assistant") this.assistant(raw);
      else if (type === "user") this.user(raw);
      else if (type === "result") parsed.result = this.result(raw);
      else this.push("warning", { message: "Unrecognized Claude Code event.", eventType: this.retain(type, MAX_LABEL_CHARS) });
    }
    return parsed;
  }

  /** Why the run must not count: a tool outside the allowlist, or a model other than the configured one. */
  public voidReason(): string | undefined {
    if (this.disallowed.size) return `disallowed_tool: Claude Code used tools outside the allowlist ${CLAUDE_CODE_ALLOWED_TOOLS.join(", ")}: ${[...this.disallowed].join(", ")}.`;
    if (this.mismatch !== undefined) return `model_mismatch: Claude Code served ${this.mismatch}, not the configured ${this.model}.`;
    return undefined;
  }

  /** A completing attempt must itself have reported the model that served it. */
  public unconfirmedModel(): string | undefined {
    return this.served ? undefined : `Claude Code reported no resolved model, so the configured ${this.model} was not confirmed.`;
  }

  /**
   * The one output budget of a run, shared by both attempts: the bytes the next attempt may produce are the limit less
   * the output stored so far and the newlines the next attempt adds to the transcript (its stdout/stderr separator, and
   * the attempt separator after a first attempt). The output so far is the larger of the raw bytes the runner capped
   * and the redacted transcript the panel bounds, so redaction, which shrinks a long credential and grows a short one,
   * can widen neither budget. `stored` applies the same limit to what a terminal returns.
   */
  public remainingOutputBytes(): number {
    if (!this.transcript.length) return this.maxOutputBytes - 1;
    const separators = this.transcript.length * 2 - 1;
    return this.maxOutputBytes - Math.max(this.rawBytes + separators, Buffer.byteLength(this.transcript.join("\n"))) - 2;
  }

  /** A value as stored: redacted in full first, then cut to its retention limit, so no cut can split a credential. */
  public retain(value: string, max: number): string {
    const redacted = redactText(value, this.secrets);
    return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
  }

  public complete(payload: Omit<HarnessOutput, "terminal" | "events" | "transcript">): SlotHarnessOutput {
    const uninspected = this.truncated ? [...payload.uninspected, { scope: "harness-events", reason: "Normalized event retention limit reached; telemetry was truncated." }] : payload.uninspected;
    return this.stored({ terminal: "completed", ...payload, uninspected, ...this.outputs() });
  }

  public finish(terminal: HarnessOutput["terminal"], reason: string): SlotHarnessOutput {
    return this.stored({ ...failure(terminal, redactText(reason, this.secrets)), ...this.outputs() });
  }

  /**
   * The output as returned, held to the limit the panel applies to each channel: a transcript or serialized events over
   * it end the run timed_out here, so the adapter's terminal agrees with the panel's bound. Cancellation keeps its
   * terminal, as it does in the panel.
   */
  private stored(output: SlotHarnessOutput): SlotHarnessOutput {
    if (output.terminal === "canceled") return output;
    const transcriptBytes = Buffer.byteLength(output.transcript ?? "");
    const eventBytes = Buffer.byteLength(JSON.stringify(output.events));
    if (transcriptBytes <= this.maxOutputBytes && eventBytes <= this.maxOutputBytes) return output;
    const reason = `Claude Code output exceeded its ${this.maxOutputBytes}-byte budget once stored (transcript ${transcriptBytes} bytes, events ${eventBytes} bytes).`;
    return { ...failure("timed_out", reason), events: output.events, transcript: output.transcript, observed: output.observed };
  }

  private outputs(): Pick<SlotHarnessOutput, "events" | "transcript" | "observed"> {
    return { events: redactJson(this.events, this.secrets), transcript: this.transcript.join("\n"), observed: this.observation() };
  }

  private observation(): SlotObservation {
    const observed: SlotObservation = {};
    if (this.harnessVersion) observed.harnessVersion = this.harnessVersion;
    // A model matching the closed rule is the configured model; any other is reported as served, which voids the run.
    if (this.mismatch !== undefined) observed.model = redactText(this.mismatch, this.secrets);
    else if (this.sawModel) observed.model = this.model;
    if (this.disallowed.size) observed.disallowedTools = [...this.disallowed].map(tool => redactText(tool, this.secrets));
    const usage: NonNullable<SlotObservation["usage"]> = {};
    if (this.inputTokens !== undefined) usage.inputTokens = this.inputTokens;
    if (this.outputTokens !== undefined) usage.outputTokens = this.outputTokens;
    if (this.costUsd !== undefined) usage.costUsd = this.costUsd;
    if (Object.keys(usage).length) observed.usage = usage;
    return observed;
  }

  /** Check one reported model identity in full; return its stored form, truncated only for retention. */
  private noteModel(value: unknown, served: boolean): string | undefined {
    if (typeof value !== "string" || !value.trim()) return undefined;
    this.sawModel = true;
    if (served) this.served = true;
    // A truncated identity is marked, so its stored form can never read as the configured model.
    const stored = this.retain(value, MAX_MODEL_CHARS);
    if (this.mismatch === undefined && !resolvedModelMatches(this.model, value)) this.mismatch = stored;
    return stored;
  }

  private system(raw: Record<string, unknown>): void {
    if (raw.subtype !== "init") { this.push("message", { subtype: typeof raw.subtype === "string" ? this.retain(raw.subtype, MAX_LABEL_CHARS) : "unknown" }); return; }
    const data: Record<string, JsonValue> = {};
    const model = this.noteModel(raw.model, false);
    if (model) data.model = model;
    const version = typeof raw.claude_code_version === "string" ? parseClaudeCodeVersion(raw.claude_code_version) : undefined;
    if (version) { this.harnessVersion = version; data.harnessVersion = version; }
    if (typeof raw.permissionMode === "string") data.permissionMode = this.retain(raw.permissionMode, MAX_LABEL_CHARS);
    if (Array.isArray(raw.tools)) data.tools = raw.tools.filter((tool): tool is string => typeof tool === "string").slice(0, 256).map(tool => this.retain(tool, MAX_TOOL_CHARS));
    this.push("started", data);
  }

  private assistant(raw: Record<string, unknown>): void {
    const body = isRecord(raw.message) ? raw.message : {};
    const model = this.noteModel(body.model, true);
    this.push("message", model ? { role: "assistant", model } : { role: "assistant" });
    if (!Array.isArray(body.content)) return;
    for (const item of body.content) {
      // Client and server tool use alike (`tool_use`, `server_tool_use`, `mcp_tool_use`).
      if (!isRecord(item) || typeof item.type !== "string" || !item.type.endsWith("tool_use")) continue;
      // The allowlist check sees the full name; only the stored name is truncated.
      const named = typeof item.name === "string" && item.name.length > 0;
      const tool = named ? this.retain(item.name as string, MAX_TOOL_CHARS) : `(unnamed ${this.retain(item.type, MAX_LABEL_CHARS)})`;
      const allowed = item.type === "tool_use" && named && CLAUDE_CODE_ALLOWED_TOOLS.includes(item.name as string);
      if (!allowed) this.disallowed.add(tool);
      this.push("tool_started", { tool, allowed });
    }
  }

  private user(raw: Record<string, unknown>): void {
    const content = isRecord(raw.message) && Array.isArray(raw.message.content) ? raw.message.content : [];
    const results = content.filter(item => isRecord(item) && item.type === "tool_result") as Record<string, unknown>[];
    if (!results.length) { this.push("message", { role: "user" }); return; }
    for (const item of results) this.push("tool_finished", { isError: item.is_error === true });
  }

  private result(raw: Record<string, unknown>): StreamResult {
    // A result that names its model is evidence too: a contradictory one is a mismatch.
    this.noteModel(raw.model, true);
    const usage: Record<string, JsonValue> = {};
    if (isRecord(raw.usage)) {
      for (const key of ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"]) {
        const value = count(raw.usage[key]);
        if (value !== undefined) usage[key] = value;
      }
      const input = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].map(key => usage[key]).filter((value): value is number => typeof value === "number");
      if (input.length) this.inputTokens = (this.inputTokens ?? 0) + input.reduce((sum, value) => sum + value, 0);
      if (typeof usage.output_tokens === "number") this.outputTokens = (this.outputTokens ?? 0) + usage.output_tokens;
    }
    const cost = amount(raw.total_cost_usd);
    if (cost !== undefined) this.costUsd = (this.costUsd ?? 0) + cost;
    const models: Record<string, JsonValue> = {};
    if (isRecord(raw.modelUsage)) {
      // Every usage key is checked; only the first 32 are kept in the usage event.
      for (const [index, [name, entry]] of Object.entries(raw.modelUsage).entries()) {
        const model = this.noteModel(name, true);
        if (!model || index >= MAX_USAGE_MODELS) continue;
        const summary: Record<string, JsonValue> = {};
        if (isRecord(entry)) for (const key of ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"]) { const value = count(entry[key]); if (value !== undefined) summary[key] = value; }
        if (isRecord(entry) && amount(entry.costUSD) !== undefined) summary.costUsd = amount(entry.costUSD)!;
        models[model] = summary;
      }
    }
    this.push("usage", { usage, models, ...(cost === undefined ? {} : { costUsd: cost }) });
    const isError = raw.is_error === true || (typeof raw.subtype === "string" && raw.subtype !== "success");
    const data: Record<string, JsonValue> = { subtype: typeof raw.subtype === "string" ? this.retain(raw.subtype, MAX_LABEL_CHARS) : "unknown", isError };
    const turns = count(raw.num_turns);
    if (turns !== undefined) data.turns = turns;
    const duration = count(raw.duration_ms);
    if (duration !== undefined) data.durationMs = duration;
    this.push(isError ? "error" : "completed", data);
    return { text: typeof raw.result === "string" ? raw.result : undefined, isError };
  }

  private push(type: NormalizedRunEvent["type"], data: Record<string, JsonValue>): void {
    if (this.truncated) return;
    if (this.events.length >= MAX_EVENTS - 1) {
      this.events.push({ sequence: this.events.length, at: new Date().toISOString(), type: "warning", data: { message: `Normalized events truncated at the ${MAX_EVENTS}-event retention limit.` } });
      this.truncated = true;
      return;
    }
    this.events.push({ sequence: this.events.length, at: new Date().toISOString(), type, data });
  }
}
