import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_POLICY, lensOutputSchema, type SlotHarnessInput } from "@superfunctions/reviewfn-core";

import { ClaudeCodeHarnessAdapter } from "../src/index.js";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitFor(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  for (const started = Date.now(); Date.now() - started < ms; await new Promise(resolve => setTimeout(resolve, 25))) if (await check()) return true;
  return check();
}

// The default runner is the shared process-group runner from reviewfn-core; a fake `claude` script stands in for the CLI.
describe.skipIf(process.platform === "win32")("ClaudeCodeHarnessAdapter process control", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), "reviewfn-claude-group-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  async function fakeClaude(): Promise<string> {
    const executable = path.join(directory, "claude");
    // A descendant that ignores SIGTERM proves the whole group is killed, not only the direct child.
    await writeFile(executable, [
      "#!/bin/sh",
      "echo '{\"type\":\"system\",\"subtype\":\"init\",\"model\":\"claude-opus-5-5\",\"claude_code_version\":\"2.1.325\"}'",
      "(trap '' TERM; exec sleep 60) &",
      "echo $! > \"$PWD/descendant.pid\"",
      "exec sleep 60",
    ].join("\n"), { mode: 0o700 });
    await chmod(executable, 0o700);
    return executable;
  }

  function input(timeoutMs: number, signal?: AbortSignal): SlotHarnessInput {
    return {
      runId: "run", workspace: directory,
      change: { repositoryId: "repo", host: "local", targetBranch: "main", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), mergeBaseCommit: "a".repeat(40), diffDigest: "c".repeat(64), changedPaths: [], capturedAt: "2026-01-01T00:00:00.000Z" },
      context: { version: 1, sources: [], selection: { candidates: [], selected: [], rule: "none" }, limits: { maxSources: 1, maxBytes: 1, maxDepth: 1 }, incompleteReasons: [], digest: "d".repeat(64) },
      policy: { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, harnessTimeoutMs: timeoutMs } },
      configuration: { ...DEFAULT_CONFIG, harness: { adapter: "claude-code", version: "1" }, inference: { provider: "anthropic", model: "claude-opus-5-5", auth: "api-key", credentialEnv: "REVIEW_AUTH" } },
      testReceipts: [], prompt: "review", outputSchema: lensOutputSchema, ...(signal ? { signal } : {}),
    };
  }

  it("ends timed_out and kills the whole process group", async () => {
    const harness = new ClaudeCodeHarnessAdapter({ executable: await fakeClaude(), environment: { PATH: process.env.PATH, REVIEW_AUTH: "credential-value" } });
    const output = await harness.run(input(750));
    expect(output.terminal).toBe("timed_out");
    expect(output.events[0]).toMatchObject({ type: "started", data: { model: "claude-opus-5-5", harnessVersion: "2.1.325" } });
    const pid = Number((await readFile(path.join(directory, "descendant.pid"), "utf8")).trim());
    expect(pid).toBeGreaterThan(0);
    expect(await waitFor(() => !alive(pid), 5_000)).toBe(true);
  }, 15_000);

  it("ends canceled and kills the whole process group when the slot is aborted", async () => {
    const harness = new ClaudeCodeHarnessAdapter({ executable: await fakeClaude(), environment: { PATH: process.env.PATH, REVIEW_AUTH: "credential-value" } });
    const controller = new AbortController();
    const pidFile = path.join(directory, "descendant.pid");
    const running = harness.run(input(60_000, controller.signal));
    expect(await waitFor(() => readFile(pidFile, "utf8").then(text => text.trim().length > 0, () => false), 5_000)).toBe(true);
    controller.abort();
    const output = await running;
    expect(output.terminal).toBe("canceled");
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(await waitFor(() => !alive(pid), 5_000)).toBe(true);
  }, 15_000);
});
