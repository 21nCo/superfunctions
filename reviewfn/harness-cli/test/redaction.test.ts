import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_POLICY, lensOutputSchema, type CommandRunner, type ReviewFnConfig, type SlotHarnessInput } from "@superfunctions/reviewfn-core";

import { AGENT, LAUNCH } from "./launcher.js";
import { CliHarnessAdapter } from "../src/index.js";

// Its own test file, so no other test has raised this process's peak resident memory first.
describe("CliHarnessAdapter redaction cost", () => {
  it("redacts a 4 MB escape-dense transcript with nested, overlapping credentials in bounded memory and time", async () => {
    const credential = ["test", '"cred"', "\\value"].join("-");
    const nested = [1, 2, 3].map(depth => Array.from({ length: depth }).reduce<string>(text => JSON.stringify(text), credential));
    const answer = JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] });
    const stdout = `${"a\\n".repeat(1_300_000)}\n${`${credential}${nested.join("")}`.repeat(2_000)}\n${answer}\n`;
    const runner: CommandRunner = async (_command, args) => args.includes("--version")
      ? { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false }
      : { code: 0, signal: null, stdout, stderr: "", timedOut: false, canceled: false };
    const config: ReviewFnConfig = {
      ...DEFAULT_CONFIG,
      harness: { adapter: "cli", version: "1", executable: AGENT, profile: "fake", profileDefinition: { argv: [...LAUNCH], promptVia: "stdin", outputVia: "stdout-last-json", envAllowlist: [], modelReport: "none", capabilities: { structuredOutput: false, sandbox: "tree-verified-only" }, versionArgv: [...LAUNCH, "--version"] } },
      inference: { provider: "fixture", model: "fixture-model", auth: "api-key", credentialEnv: "REVIEW_AUTH" },
    };
    const input: SlotHarnessInput = {
      runId: "run", workspace: tmpdir(),
      change: { repositoryId: "repo", host: "local", targetBranch: "main", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), mergeBaseCommit: "a".repeat(40), diffDigest: "c".repeat(64), changedPaths: ["src/index.ts"], capturedAt: "2026-01-01T00:00:00.000Z" },
      context: { version: 1, sources: [], selection: { candidates: [], selected: [], rule: "none" }, limits: { maxSources: 1, maxBytes: 1, maxDepth: 1 }, incompleteReasons: [], digest: "d".repeat(64) },
      policy: { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, maxOutputBytes: 8_000_000, harnessTimeoutMs: 60_000 } },
      configuration: config, testReceipts: [], prompt: "Review the change.", outputSchema: lensOutputSchema,
    };
    const before = process.resourceUsage().maxRSS;
    const started = performance.now();
    const output = await new CliHarnessAdapter({ environment: { PATH: process.env.PATH, REVIEW_AUTH: credential }, runner }).run(input);
    const elapsed = performance.now() - started;
    expect(output.terminal).toBe("completed");
    expect(output.transcript).not.toMatch(/cred|value/);
    expect(output.transcript).toContain('"inspectedPaths"');
    // maxRSS is in kibibytes. Decoding each level into an offset table per character took about 300 MiB here.
    expect((process.resourceUsage().maxRSS - before) / 1024).toBeLessThan(160);
    expect(elapsed).toBeLessThan(5_000);
  }, 30_000);
});
