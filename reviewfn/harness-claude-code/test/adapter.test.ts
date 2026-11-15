import { readFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_POLICY, harnessAuthDiagnostics, lensOutputSchema, type CommandResult, type CommandRunnerOptions, type ReviewFnConfig, type SlotHarnessInput } from "@superfunctions/reviewfn-core";

import { CLAUDE_CODE_ALLOWED_TOOLS, CLAUDE_CODE_DISALLOWED_TOOLS, ClaudeCodeHarnessAdapter, claudeCodeArguments, parseClaudeCodeVersion, resolvedModelMatches, type CommandRunner } from "../src/index.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => readFileSync(path.join(fixtures, `${name}.jsonl`), "utf8");
const MODEL = "claude-opus-5-5";
const CREDENTIAL = "reviewfn-fixture-credential-7731";

const configuration: ReviewFnConfig = { ...DEFAULT_CONFIG, harness: { adapter: "claude-code", version: "1" }, inference: { provider: "anthropic", model: MODEL, auth: "api-key", credentialEnv: "REVIEW_AUTH" } };
const baseInput: SlotHarnessInput = {
  runId: "run", workspace: ".",
  change: { repositoryId: "repo", host: "local", targetBranch: "main", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), mergeBaseCommit: "a".repeat(40), diffDigest: "c".repeat(64), changedPaths: ["src/index.ts"], capturedAt: "2026-01-01T00:00:00.000Z" },
  context: { version: 1, sources: [], selection: { candidates: [], selected: [], rule: "none" }, limits: { maxSources: 1, maxBytes: 1, maxDepth: 1 }, incompleteReasons: [], digest: "d".repeat(64) },
  policy: DEFAULT_POLICY, configuration, testReceipts: [], prompt: "Review the change.", outputSchema: lensOutputSchema,
};
const environment = { PATH: "/usr/bin:/bin", HOME: "/Users/operator", LANG: "en_US.UTF-8", TMPDIR: "/tmp", REVIEW_AUTH: CREDENTIAL, GITHUB_TOKEN: "publication-private-token", SSH_AUTH_SOCK: "/tmp/agent.sock" };

interface Call { command: string; args: string[]; options: CommandRunnerOptions; home?: { path: string; existed: boolean } }
const ok = (stdout: string): CommandResult => ({ code: 0, signal: null, stdout, stderr: "", timedOut: false, canceled: false });

/** A fake runner that replays one recorded stream per attempt and answers `--version`. */
function replay(streams: Array<string | CommandResult>, version = "2.1.325 (Claude Code)"): { runner: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...streams];
  const runner: CommandRunner = async (command, args, options) => {
    const home = options.env.HOME;
    const call: Call = { command, args, options, ...(home ? { home: { path: home, existed: await lstat(home).then(() => true, () => false) } } : {}) };
    calls.push(call);
    if (args[0] === "--version") return ok(version);
    const next = queue.shift();
    if (next === undefined) throw new Error("unexpected attempt");
    return typeof next === "string" ? ok(next) : next;
  };
  return { runner, calls };
}

function adapter(streams: Array<string | CommandResult>, options: { version?: string; env?: NodeJS.ProcessEnv } = {}) {
  const fake = replay(streams, options.version);
  return { adapter: new ClaudeCodeHarnessAdapter({ runner: fake.runner, environment: options.env ?? environment }), calls: fake.calls };
}

describe("ClaudeCodeHarnessAdapter invocation", () => {
  it("runs print mode with the exact tool allowlist, denylist and isolation flags", async () => {
    const { adapter: harness, calls } = adapter([fixture("completed-review")]);
    await harness.run(baseInput);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("claude");
    expect(calls[0].args).toEqual([
      "-p", "--output-format", "stream-json", "--verbose", "--model", "claude-opus-5-5",
      "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob", "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch",
      "--permission-mode", "default", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--setting-sources", "", "--no-session-persistence",
    ]);
    expect(claudeCodeArguments(MODEL)).toEqual(calls[0].args);
    expect(CLAUDE_CODE_ALLOWED_TOOLS).toEqual(["Read", "Grep", "Glob"]);
    expect(CLAUDE_CODE_DISALLOWED_TOOLS).toEqual(["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"]);
    expect(calls[0].options.cwd).toBe(".");
    expect(calls[0].options.stdin).toMatch(/^Review the change\.\n\nOutput contract: .*exactly one JSON object/);
    expect(calls[0].options.stdin).toContain(JSON.stringify(lensOutputSchema));
  });

  it("passes only the environment allowlist, with a fresh home that is removed afterwards", async () => {
    const { adapter: harness, calls } = adapter([fixture("completed-review")]);
    await harness.run(baseInput);
    const env = calls[0].options.env;
    expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_API_KEY", "HOME", "LANG", "PATH", "REVIEW_AUTH", "TMPDIR"]);
    expect(env.ANTHROPIC_API_KEY).toBe(CREDENTIAL);
    expect(env.HOME).not.toBe(environment.HOME);
    expect(calls[0].home?.existed).toBe(true);
    await expect(lstat(env.HOME!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the operator home for subscription auth and passes no API key", async () => {
    const { adapter: harness, calls } = adapter([fixture("completed-review")], { env: { PATH: "/bin", HOME: "/Users/operator", CLAUDE_CODE_OAUTH_TOKEN: "oauth-private-token", OTHER: "x" } });
    const output = await harness.run({ ...baseInput, configuration: { ...configuration, inference: { provider: "anthropic", model: MODEL, auth: "subscription", credentialEnv: "CLAUDE_CODE_OAUTH_TOKEN" } } });
    expect(output.terminal).toBe("completed");
    expect(calls[0].options.env).toEqual({ PATH: "/bin", HOME: "/Users/operator", CLAUDE_CODE_OAUTH_TOKEN: "oauth-private-token" });
  });
});

describe("ClaudeCodeHarnessAdapter results", () => {
  it("parses a completed review with usage, the resolved model and content-free events", async () => {
    const { adapter: harness } = adapter([fixture("completed-review")]);
    const output = await harness.run(baseInput);
    expect(output.terminal).toBe("completed");
    expect(output.findings.map(item => item.title)).toEqual(["Missing null guard"]);
    expect(output.evidence.map(item => item.id)).toEqual(["e1"]);
    expect(output.inspectedPaths).toEqual(["src/index.ts"]);
    expect(output.requirements).toEqual([]);
    // The dated model matches the closed rule, so the configured model is the observed identity.
    expect(output.observed).toEqual({ harnessVersion: "2.1.325", model: MODEL, usage: { inputTokens: 2000, outputTokens: 420, costUsd: 0.1875 } });
    const usage = output.events.find(event => event.type === "usage");
    expect(usage?.data).toEqual({ usage: { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 500, output_tokens: 420 }, models: { "claude-opus-5-5-20261101": { inputTokens: 1200, outputTokens: 420, cacheReadInputTokens: 500, cacheCreationInputTokens: 300, costUsd: 0.1875 } }, costUsd: 0.1875 });
    expect(output.events.filter(event => event.type === "tool_started").map(event => event.data)).toEqual([{ tool: "Read", allowed: true }, { tool: "Grep", allowed: true }]);
    expect(output.events.map(event => event.sequence)).toEqual(output.events.map((_, index) => index));
    expect(output.events.at(-1)?.type).toBe("completed");
    // Message and tool content stays in the transcript only.
    expect(JSON.stringify(output.events)).not.toContain("parse(body)");
    expect(JSON.stringify(output.events)).not.toContain("Missing null guard");
    expect(output.transcript).toContain("parse(body)");
  });

  it("reports a disallowed tool so the panel voids the slot, without a repair attempt", async () => {
    const { adapter: harness, calls } = adapter([fixture("disallowed-tool")]);
    const output = await harness.run(baseInput);
    expect(output.terminal).toBe("failed");
    expect(output.error).toMatch(/^disallowed_tool: .*Bash/);
    expect(output.observed?.disallowedTools).toEqual(["Bash"]);
    expect(output.findings).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("reports a served model outside the closed rule so the panel voids the slot", async () => {
    const { adapter: harness } = adapter([fixture("model-mismatch")]);
    const output = await harness.run(baseInput);
    expect(output.terminal).toBe("failed");
    expect(output.error).toMatch(/^model_mismatch: /);
    expect(output.observed?.model).toBe("claude-sonnet-5-5");
    expect(output.findings).toEqual([]);
  });

  it("matches a resolved model only exactly or with an eight-digit date suffix", () => {
    expect(resolvedModelMatches(MODEL, MODEL)).toBe(true);
    expect(resolvedModelMatches(MODEL, "claude-opus-5-5-20261101")).toBe(true);
    for (const resolved of ["claude-opus-5-5-2026110", "claude-opus-5-5-202611011", "claude-opus-5-5-latest", "claude-opus-5-5x", "xclaude-opus-5-5", "claude-opus-5-5-20261101-v2", "claude-opus-5"]) expect(resolvedModelMatches(MODEL, resolved)).toBe(false);
    expect(resolvedModelMatches("claude.opus[1m]", "claudeXopus1")).toBe(false);
    expect(resolvedModelMatches("claude.opus[1m]", "claude.opus[1m]-20261101")).toBe(true);
  });

  it("re-prompts once with the validation errors, then ends malformed", async () => {
    const { adapter: harness, calls } = adapter([fixture("malformed-output"), fixture("schema-invalid-output")]);
    const output = await harness.run(baseInput);
    expect(output.terminal).toBe("malformed");
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual(calls[0].args);
    const repair = calls[1].options.stdin!;
    expect(repair.startsWith(calls[0].options.stdin!)).toBe(true);
    expect(repair).toContain("The final result message is not exactly one JSON object.");
    expect(repair).toContain("Here is my review: the parser lacks a null guard.");
    expect(output.error).toMatch(/after one repair attempt: .*must have required property/);
    expect(output.findings).toEqual([]);
  });

  it("completes when the repair attempt returns valid output, counting both attempts' usage", async () => {
    const { adapter: harness, calls } = adapter([fixture("schema-invalid-output"), fixture("completed-review")]);
    const output = await harness.run(baseInput);
    expect(output.terminal).toBe("completed");
    expect(calls[1].options.stdin).toMatch(/\/findings\/0: must have required property/);
    expect(output.observed?.usage).toEqual({ inputTokens: 4000, outputTokens: 840, costUsd: 0.375 });
    expect(output.events.filter(event => event.type === "started")).toHaveLength(2);
  });

  it("accepts the JSON object inside one code fence", async () => {
    const stream = fixture("completed-review").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    const result = stream.at(-1)!;
    result.result = `\`\`\`json\n${String(result.result)}\n\`\`\``;
    const { adapter: harness } = adapter([stream.map(event => JSON.stringify(event)).join("\n")]);
    expect((await harness.run(baseInput)).terminal).toBe("completed");
  });

  it("ends timed_out without a repair attempt when the runner times out", async () => {
    const { adapter: harness, calls } = adapter([{ code: null, signal: "SIGTERM", stdout: fixture("completed-review").split("\n").slice(0, 2).join("\n"), stderr: "", timedOut: true, canceled: false }]);
    const output = await harness.run({ ...baseInput, policy: { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, harnessTimeoutMs: 1234 } } });
    expect(output.terminal).toBe("timed_out");
    expect(calls).toHaveLength(1);
    expect(calls[0].options.timeoutMs).toBeLessThanOrEqual(1234);
    expect(calls[0].options.timeoutMs).toBeGreaterThan(0);
  });

  it("reports cancellation and rate limits as their own terminals", async () => {
    const canceled = adapter([{ code: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: false, canceled: true }]);
    expect((await canceled.adapter.run(baseInput)).terminal).toBe("canceled");
    const limited = adapter([{ ...ok(fixture("rate-limited")), code: 1 }]);
    const output = await limited.adapter.run(baseInput);
    expect(output.terminal).toBe("quota_exhausted");
    expect(limited.calls).toHaveLength(1);
  });

  it("fails a run whose stream never reports the model that served it", async () => {
    const stream = fixture("completed-review").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(event => event.type === "result").map(event => ({ ...event, modelUsage: {} }));
    const { adapter: harness } = adapter([stream.map(event => JSON.stringify(event)).join("\n")]);
    const output = await harness.run(baseInput);
    expect(output.terminal).toBe("failed");
    expect(output.error).toMatch(/no resolved model/);
  });

  it("requires the repair attempt to report its own serving model", async () => {
    const repair = fixture("completed-review").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(event => event.type === "result").map(({ modelUsage: _omitted, ...event }) => event);
    const { adapter: harness, calls } = adapter([fixture("malformed-output"), repair.map(event => JSON.stringify(event)).join("\n")]);
    const output = await harness.run(baseInput);
    expect(calls).toHaveLength(2);
    expect(output.terminal).toBe("failed");
    expect(output.error).toMatch(/no resolved model/);
    expect(output.findings).toEqual([]);
  });

  it("reports a result model that contradicts the usage models as a mismatch", async () => {
    const stream = fixture("completed-review").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
      .map(event => event.type === "result" ? { ...event, model: "different-model" } : event);
    const { adapter: harness } = adapter([stream.map(event => JSON.stringify(event)).join("\n")]);
    const output = await harness.run(baseInput);
    expect(output.terminal).toBe("failed");
    expect(output.error).toMatch(/^model_mismatch: Claude Code served different-model/);
    expect(output.observed?.model).toBe("different-model");
  });

  it("checks every usage model, not only the usage entries it retains", async () => {
    // 32 matching dated entries, then one other model: retention keeps 32 entries, the check sees all 33.
    const crowded = (text: string) => text.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>).map(event => event.type !== "result" ? event : {
      ...event,
      modelUsage: { ...Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`${MODEL}-202601${String(index + 1).padStart(2, "0")}`, { inputTokens: 1 }])), "claude-sonnet-5-5": { inputTokens: 1 } },
    }).map(event => JSON.stringify(event)).join("\n");
    const first = adapter([crowded(fixture("completed-review"))]);
    const output = await first.adapter.run(baseInput);
    expect(output.terminal).toBe("failed");
    expect(output.error).toMatch(/^model_mismatch: Claude Code served claude-sonnet-5-5/);
    expect(output.observed?.model).toBe("claude-sonnet-5-5");
    const usage = output.events.find(event => event.type === "usage")?.data as { models: Record<string, unknown> };
    expect(Object.keys(usage.models)).toHaveLength(32);
    // The same mismatch in the repair attempt voids the run too.
    const repair = adapter([fixture("malformed-output"), crowded(fixture("completed-review"))]);
    const repaired = await repair.adapter.run(baseInput);
    expect(repair.calls).toHaveLength(2);
    expect(repaired.terminal).toBe("failed");
    expect(repaired.error).toMatch(/^model_mismatch: Claude Code served claude-sonnet-5-5/);
    expect(repaired.findings).toEqual([]);
  });

  it("gives the repair attempt only the output budget the first attempt left", async () => {
    const malformed = fixture("malformed-output");
    const limit = Buffer.byteLength(malformed) + 4_096;
    const limits = (maxOutputBytes: number) => ({ ...baseInput, policy: { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, maxOutputBytes } } });
    const shared = adapter([malformed, fixture("schema-invalid-output")]);
    await shared.adapter.run(limits(limit));
    expect(shared.calls.map(call => call.options.maxOutputBytes)).toEqual([limit, limit - Buffer.byteLength(`${malformed}\n`) - 2]);
    // A first attempt that used the whole budget leaves nothing for a repair, which is not started.
    const spent = adapter([malformed, fixture("completed-review")]);
    const output = await spent.adapter.run(limits(Buffer.byteLength(malformed) + 1));
    expect(output.terminal).toBe("timed_out");
    expect(output.error).toMatch(/whole byte budget/);
    expect(spent.calls).toHaveLength(1);
  });

  it("measures the repair budget in the raw bytes the runner counted, whatever redaction removed", async () => {
    const malformed = fixture("malformed-output");
    const stderr = `warning: ${CREDENTIAL} was rejected\n`;
    const limit = Buffer.byteLength(malformed) + 4_096;
    const echoed = adapter([{ ...ok(malformed), stderr }, fixture("schema-invalid-output")]);
    await echoed.adapter.run({ ...baseInput, policy: { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, maxOutputBytes: limit } } });
    expect(echoed.calls.map(call => call.options.maxOutputBytes)).toEqual([limit, limit - Buffer.byteLength(`${malformed}\n${stderr}`) - 2]);
  });

  it("redacts a credential echoed in output from stored events, transcript and payload", async () => {
    const { adapter: harness } = adapter([fixture("credential-echo")]);
    const output = await harness.run(baseInput);
    expect(output.terminal).toBe("completed");
    expect(fixture("credential-echo")).toContain(CREDENTIAL);
    expect(JSON.stringify(output)).not.toContain(CREDENTIAL);
    expect(output.transcript).toContain("[REDACTED]");
    expect(output.evidence[0].description).toBe("Found [REDACTED] in the process environment.");
  });
});

describe("ClaudeCodeHarnessAdapter trust and preflight", () => {
  it("refuses a pull-request identity before starting Claude Code", async () => {
    const { adapter: harness, calls } = adapter([fixture("completed-review")]);
    for (const auth of ["api-key", "subscription"]) {
      const output = await harness.run({ ...baseInput, change: { ...baseInput.change, pullRequest: 7 }, configuration: { ...configuration, inference: { ...configuration.inference, auth } } });
      expect(output.terminal).toBe("failed");
      expect(output.error).toMatch(/trusted local reviews/);
    }
    expect(calls).toHaveLength(0);
  });

  it("fails preflight with REVIEWFN_PR_AUTH_REQUIRED for every auth mode when a pull request is reviewed", () => {
    for (const auth of ["api-key", "subscription"]) {
      expect(harnessAuthDiagnostics({ pullRequest: 7 }, "claude-code", auth).map(item => item.code)).toEqual(["REVIEWFN_PR_AUTH_REQUIRED"]);
      expect(harnessAuthDiagnostics({}, "claude-code", auth)).toEqual([]);
    }
    expect(harnessAuthDiagnostics({ pullRequest: 7 }, "codex", "action-proxy")).toEqual([]);
    expect(harnessAuthDiagnostics({ pullRequest: 7 }, "codex", "api-key").map(item => item.code)).toEqual(["REVIEWFN_PR_AUTH_REQUIRED"]);
  });

  it("resolves the reported version at or above the floor", async () => {
    for (const [reported, version] of [["2.1.325 (Claude Code)", "2.1.325"], ["2.1.0 (Claude Code)", "2.1.0"], ["10.0.1", "10.0.1"]]) {
      const { adapter: harness, calls } = adapter([], { version: reported });
      const result = await harness.preflight(configuration);
      expect(result.ok).toBe(true);
      expect(result.resolved).toEqual({ provider: "anthropic", model: MODEL, auth: "api-key", harnessVersion: version });
      expect(harness.capabilities.version).toBe(version);
      expect(calls[0].args).toEqual(["--version"]);
      expect(calls[0].options.env.HOME).not.toBe(environment.HOME);
    }
  });

  it("fails preflight with REVIEWFN_HARNESS_VERSION below the floor or without a version", async () => {
    for (const reported of ["2.0.99 (Claude Code)", "1.9.400 (Claude Code)", "Claude Code"]) {
      const { adapter: harness } = adapter([], { version: reported });
      const result = await harness.preflight(configuration);
      expect(result.ok).toBe(false);
      expect(result.resolved).toBeUndefined();
      expect(result.diagnostics.filter(item => item.level === "error").map(item => item.code)).toEqual(["REVIEWFN_HARNESS_VERSION"]);
    }
    expect(parseClaudeCodeVersion("2.1.325 (Claude Code)")).toBe("2.1.325");
    expect(parseClaudeCodeVersion("v1.2.3.4")).toBeUndefined();
  });

  it("refuses unsupported providers, auth modes, unpinned models and missing credentials", async () => {
    const cases: Array<[ReviewFnConfig["inference"], string]> = [
      [{ provider: "openai", model: MODEL, auth: "api-key", credentialEnv: "REVIEW_AUTH" }, "REVIEWFN_PROVIDER_UNSUPPORTED"],
      [{ provider: "anthropic", model: MODEL, auth: "action-proxy" }, "REVIEWFN_AUTH_UNSUPPORTED"],
      [{ provider: "anthropic", model: "configured", auth: "api-key", credentialEnv: "REVIEW_AUTH" }, "REVIEWFN_MODEL_REQUIRED"],
      [{ provider: "anthropic", model: "--dangerously-skip-permissions", auth: "api-key", credentialEnv: "REVIEW_AUTH" }, "REVIEWFN_MODEL_INVALID"],
      [{ provider: "anthropic", model: MODEL, auth: "api-key" }, "REVIEWFN_CREDENTIAL_MISSING"],
      [{ provider: "anthropic", model: MODEL, auth: "api-key", credentialEnv: "UNSET_CREDENTIAL" }, "REVIEWFN_CREDENTIAL_MISSING"],
      [{ provider: "anthropic", model: MODEL, auth: "api-key", credentialEnv: "HOME" }, "REVIEWFN_CREDENTIAL_INVALID"],
    ];
    for (const [inference, code] of cases) {
      const { adapter: harness, calls } = adapter([fixture("completed-review")]);
      const result = await harness.preflight({ ...configuration, inference });
      expect(result.diagnostics.filter(item => item.level === "error").map(item => item.code)).toEqual([code]);
      const output = await harness.run({ ...baseInput, configuration: { ...configuration, inference } });
      expect(output.terminal).toBe("failed");
      expect(calls.filter(call => call.args[0] !== "--version")).toHaveLength(0);
    }
  });

  it("reports an unavailable executable", async () => {
    const harness = new ClaudeCodeHarnessAdapter({ environment, runner: async () => { throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }); } });
    const result = await harness.preflight(configuration);
    expect(result.diagnostics.map(item => item.code)).toContain("REVIEWFN_CLAUDE_CODE_UNAVAILABLE");
    expect((await harness.run(baseInput)).terminal).toBe("failed");
  });
});
