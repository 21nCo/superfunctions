import { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { processExists } from "@devfn/config";

import type { runGatedCommand as GatedRunner } from "../src/gated.js";
import type { ProcessSupervisor as Supervisor } from "../src/supervisor.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const exists = async (file: string) => await stat(file).then(() => true, () => false);
// A zombie (an exited process its parent, or a container PID 1, never reaped) counts as gone.
const alive = (pid: number) => processExists(pid);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A run launches the compiled wrapper next to the supervisor, which the
// package's own build may not provide yet, so its sources are transpiled
// next to each other, where @devfn/config still resolves.
let dir: string;
let ProcessSupervisor: typeof Supervisor;
let runGatedCommand: typeof GatedRunner;
beforeAll(async () => {
  await mkdir(path.join(packageDir, "node_modules", ".cache"), { recursive: true });
  dir = await mkdtemp(path.join(packageDir, "node_modules", ".cache", "devfn-run-"));
  await writeFile(path.join(dir, "package.json"), '{ "type": "module" }');
  for (const name of await readdir(path.join(packageDir, "src"))) {
    const source = await readFile(path.join(packageDir, "src", name), "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    await writeFile(path.join(dir, name.replace(/\.ts$/, ".js")), outputText);
  }
  ({ ProcessSupervisor } = await import(/* @vite-ignore */ pathToFileURL(path.join(dir, "supervisor.js")).href) as { ProcessSupervisor: typeof Supervisor });
  ({ runGatedCommand } = await import(/* @vite-ignore */ pathToFileURL(path.join(dir, "gated.js")).href) as { runGatedCommand: typeof GatedRunner });
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

async function workspace(name: string) {
  const root = await mkdtemp(path.join(dir, `${name}-`));
  return { root, base: { root, runtimeDir: path.join(root, "runtime"), environment: { PATH: process.env.PATH ?? "" }, timeoutMs: 30_000 } };
}

// A command that starts a descendant in its group, records its PID and then waits.
const spawnsDescendant = (stdio: string, then: string) =>
  `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: '${stdio}' }); require('fs').writeFileSync('child.pid', String(c.pid)); ${then}`;

// Group containment is POSIX process groups; Windows stops a process tree instead.
describe.skipIf(process.platform === "win32")("finite process runs", () => {
  it("runs the command only after onStarted recorded its identity", async () => {
    const { root, base } = await workspace("gate");
    const recorded: number[] = [];
    await expect(new ProcessSupervisor().run({ ...base, name: "unrecorded", command: [process.execPath, "-e", "require('fs').writeFileSync('ran', '1')"],
      onStarted: async () => { throw new Error("journal unavailable"); } })).rejects.toThrow("journal unavailable");
    expect(await exists(path.join(root, "ran"))).toBe(false);
    const result = await new ProcessSupervisor().run({ ...base, name: "recorded", command: [process.execPath, "-e", "require('fs').writeFileSync('ran', String(process.ppid))"],
      onStarted: async (managed) => { recorded.push(managed.pid); expect(await exists(path.join(root, "ran"))).toBe(false); } });
    expect(result).toMatchObject({ outcome: "succeeded", exitCode: 0, signal: null });
    expect(recorded).toEqual([result.process.pid]);
    expect(Number(await readFile(path.join(root, "ran"), "utf8"))).toBe(result.process.pid);
  }, 60_000);

  it("succeeds only on exit code 0", async () => {
    const { base } = await workspace("exit");
    expect(await new ProcessSupervisor().run({ ...base, name: "exits", command: [process.execPath, "-e", "process.exit(6)"] })).toMatchObject({ outcome: "failed", exitCode: 6 });
    expect(await new ProcessSupervisor().run({ ...base, name: "succeeds", command: [process.execPath, "-e", "0"] })).toMatchObject({ outcome: "succeeded", exitCode: 0 });
  }, 60_000);

  it("stops the command and its group when the run times out", async () => {
    const { root, base } = await workspace("timeout");
    const result = await new ProcessSupervisor().run({ ...base, name: "hangs", timeoutMs: 3_000, command: [process.execPath, "-e", spawnsDescendant("ignore", "setTimeout(() => {}, 60000)")] });
    expect(result).toMatchObject({ outcome: "timed-out", exitCode: null, signal: null });
    expect(result.stopError).toBeUndefined();
    expect(alive(Number(await readFile(path.join(root, "child.pid"), "utf8")))).toBe(false);
    expect(alive(result.process.pid)).toBe(false);
  }, 60_000);

  it("stops the command and its group when the run is aborted", async () => {
    const { root, base } = await workspace("abort");
    const controller = new AbortController();
    const pending = new ProcessSupervisor().run({ ...base, name: "aborted", signal: controller.signal, command: [process.execPath, "-e", spawnsDescendant("ignore", "setTimeout(() => {}, 60000)")] });
    while (!await exists(path.join(root, "child.pid"))) await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ outcome: "cancelled", exitCode: null });
    expect(result.stopError).toBeUndefined();
    expect(alive(Number(await readFile(path.join(root, "child.pid"), "utf8")))).toBe(false);
    expect(alive(result.process.pid)).toBe(false);
  }, 60_000);

  it("never runs a command whose run was aborted before its gate opened", async () => {
    const { root, base } = await workspace("preabort");
    const controller = new AbortController();
    controller.abort();
    await expect(new ProcessSupervisor().run({ ...base, name: "cancelled", signal: controller.signal, command: [process.execPath, "-e", "require('fs').writeFileSync('ran', '1')"] }))
      .rejects.toMatchObject({ code: "DEVFN_PROCESS_START_FAILED" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await exists(path.join(root, "ran"))).toBe(false);
  }, 60_000);

  // The command must still never run once the run gave up waiting for its recording.
  it("bounds the identity recording by the run's timeout and abort, and never runs a command recorded late", async () => {
    const { root, base } = await workspace("recording");
    const command = [process.execPath, "-e", "require('fs').writeFileSync('ran', '1')"];
    const wrappers: number[] = [];
    let started = Date.now();
    await expect(new ProcessSupervisor().run({ ...base, name: "unsettled", timeoutMs: 1_000, command,
      onStarted: async (managed) => { wrappers.push(managed.pid); await new Promise(() => undefined); } })).rejects.toThrow("timed out after 1000 ms before it started");
    expect(Date.now() - started).toBeLessThan(10_000);
    let late!: () => void;
    await expect(new ProcessSupervisor().run({ ...base, name: "late", timeoutMs: 1_000, command,
      onStarted: async (managed) => { wrappers.push(managed.pid); await new Promise<void>((resolve) => { late = resolve; }); } })).rejects.toMatchObject({ code: "DEVFN_PROCESS_START_FAILED" });
    late();
    const controller = new AbortController();
    started = Date.now();
    await expect(new ProcessSupervisor().run({ ...base, name: "aborted", signal: controller.signal, command,
      onStarted: async (managed) => { wrappers.push(managed.pid); controller.abort(); await delay(1_000); } })).rejects.toThrow("was cancelled before it started");
    expect(Date.now() - started).toBeLessThan(10_000);
    await delay(1_500);
    expect(await exists(path.join(root, "ran"))).toBe(false);
    expect(wrappers.filter(alive)).toEqual([]);
  }, 60_000);

  // An abort queued any number of microtasks after the recording settles must
  // keep the gate closed: whether start is sent is decided in the same turn as
  // the send. The oracle is each wrapper's own IPC send, not supervisor state.
  it("never sends start once the run was aborted, however late after the recording", async () => {
    const sends: { signal?: AbortSignal; afterAbort: number } = { afterAbort: 0 };
    const spawn = ChildProcess.prototype.spawn;
    // Node installs send() on each IPC child while it spawns.
    ChildProcess.prototype.spawn = function (this: ChildProcess, ...args: Parameters<typeof spawn>) {
      const spawned = spawn.apply(this, args);
      const send = this.send?.bind(this) as ((...rest: unknown[]) => boolean) | undefined;
      if (send) this.send = ((message: unknown, ...rest: unknown[]) => { if (message === "start" && sends.signal?.aborted) sends.afterAbort++; return send(message, ...rest); }) as ChildProcess["send"];
      return spawned;
    };
    const rejected: { root: string; pid: number }[] = [];
    try {
      for (let depth = 1; depth <= 12; depth++) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const { root, base } = await workspace(`late-abort-${depth}`);
          const controller = new AbortController();
          sends.signal = controller.signal;
          let pid = 0;
          const onStarted = async (managed: { pid: number }) => {
            pid = managed.pid;
            let remaining = depth;
            const step = () => { if (--remaining <= 0) controller.abort(); else queueMicrotask(step); };
            queueMicrotask(step);
          };
          const outcome = await new ProcessSupervisor().run({ ...base, name: "late-abort", signal: controller.signal, command: ["/bin/sh", "-c", "printf ran > ran"], onStarted })
            .then((result) => result.outcome, (error: { code?: string }) => error.code);
          if (outcome === "DEVFN_PROCESS_START_FAILED") rejected.push({ root, pid });
          else expect(outcome).toBe("cancelled");
        }
      }
    } finally {
      ChildProcess.prototype.spawn = spawn;
    }
    expect(sends.afterAbort).toBe(0);
    expect(rejected.length).toBeGreaterThan(0);
    await delay(500);
    for (const { root, pid } of rejected) {
      expect(await exists(path.join(root, "ran"))).toBe(false);
      expect(alive(pid)).toBe(false);
    }
  }, 120_000);

  // A stopped wrapper cannot acknowledge its gate; the run's limits still end it and stop its group.
  it("bounds the launch gate acknowledgement by the run's timeout and abort", async () => {
    const { base } = await workspace("gate-ack");
    const command = [process.execPath, "-e", "setTimeout(() => {}, 60000)"];
    const freeze = async (managed: { pid: number }) => { process.kill(managed.pid, "SIGSTOP"); };
    let started = Date.now();
    const timedOut = await new ProcessSupervisor().run({ ...base, name: "unacknowledged", timeoutMs: 1_500, shutdownTimeoutMs: 500, command, onStarted: freeze });
    expect(timedOut).toMatchObject({ outcome: "timed-out", exitCode: null, signal: null });
    expect(timedOut.stopError).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(alive(timedOut.process.pid)).toBe(false);
    const controller = new AbortController();
    started = Date.now();
    const cancelled = await new ProcessSupervisor().run({ ...base, name: "unacknowledged", signal: controller.signal, shutdownTimeoutMs: 500, command,
      onStarted: async (managed) => { await freeze(managed); setTimeout(() => controller.abort(), 300); } });
    expect(cancelled).toMatchObject({ outcome: "cancelled", exitCode: null, signal: null });
    expect(cancelled.stopError).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(alive(cancelled.process.pid)).toBe(false);
  }, 60_000);

  it("ends when its command exits although a descendant still holds its output, and stops that descendant", async () => {
    const { root, base } = await workspace("drain");
    const started = Date.now();
    const result = await new ProcessSupervisor().run({ ...base, name: "lingers", timeoutMs: 20_000, command: [process.execPath, "-e", spawnsDescendant("inherit", "console.log('done'); process.exit(0)")] });
    expect(result).toMatchObject({ outcome: "succeeded", exitCode: 0 });
    expect(result.stopError).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(alive(Number(await readFile(path.join(root, "child.pid"), "utf8")))).toBe(false);
    expect(await readFile(result.process.logPath, "utf8")).toContain("done");
  }, 60_000);

  it("keeps redacted output unless discardOutput asks, whatever the given environment says", async () => {
    const { base } = await workspace("output");
    const emit = [process.execPath, "-e", "console.log('value=' + process.env.RUN_TOKEN)"];
    const environment = { ...base.environment, RUN_TOKEN: "run-secret-5521" };
    // The wrapper's own discard control in the command's environment, in any casing, is not discardOutput.
    for (const key of ["DEVFN_DISCARD_OUTPUT", "devfn_discard_output"]) {
      const kept = await new ProcessSupervisor().run({ ...base, name: "kept", command: emit, environment: { ...environment, [key]: "1" }, redactKeys: ["RUN_TOKEN"] });
      const log = await readFile(kept.process.logPath, "utf8");
      expect(log).toContain("value=[REDACTED]");
      expect(log).not.toContain("run-secret-5521");
      expect(log).not.toContain("Output of this command is not kept");
    }
    const discarded = await new ProcessSupervisor().run({ ...base, name: "discarded", command: emit, environment, discardOutput: true });
    expect(discarded).toMatchObject({ outcome: "succeeded", exitCode: 0 });
    const log = await readFile(discarded.process.logPath, "utf8");
    expect(log).toContain("Output of this command is not kept");
    expect(log).not.toContain("value=");
  }, 60_000);

  // Node ignores SIGPIPE and SIGXFSZ and opens its inspector on SIGUSR1, so a
  // wrapper that sent itself these would go on and exit 0.
  it("fails a command a signal ended, including signals Node ignores or handles", async () => {
    const { base } = await workspace("signal");
    for (const signal of ["PIPE", "XFSZ", "USR1"] as const) {
      const code = 128 + constants.signals[`SIG${signal}`];
      const command = ["/bin/sh", "-c", `kill -${signal} $$`];
      const result = await new ProcessSupervisor().run({ ...base, name: `sig${signal}`, command });
      expect(result).toMatchObject({ outcome: "failed", exitCode: code, signal: null });
      expect(await readFile(result.process.logPath, "utf8")).not.toContain("Debugger listening");
      const failure = await runGatedCommand(command[0], command.slice(1), { onLaunched: async () => undefined }).then(() => undefined, (error: unknown) => error);
      expect(failure).toMatchObject({ code });
      expect((failure as { stderr: string }).stderr).not.toContain("Debugger listening");
    }
    const command = ["/bin/sh", "-c", "kill -TERM $$"];
    expect(await new ProcessSupervisor().run({ ...base, name: "sigTERM", command })).toMatchObject({ outcome: "failed", exitCode: null, signal: "SIGTERM" });
    await expect(runGatedCommand(command[0], command.slice(1), { onLaunched: async () => undefined })).rejects.toMatchObject({ signal: "SIGTERM" });
  }, 60_000);

  it("rejects a timeout a timer cannot hold before launching anything", async () => {
    const { root, base } = await workspace("bad-timeout");
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
      await expect(new ProcessSupervisor().run({ ...base, name: "invalid", timeoutMs, command: [process.execPath, "-e", "require('fs').writeFileSync('ran', '1')"] }))
        .rejects.toMatchObject({ code: "DEVFN_PROCESS_START_FAILED" });
    }
    expect(await exists(path.join(root, "runtime"))).toBe(false);
    expect(await exists(path.join(root, "ran"))).toBe(false);
  }, 60_000);
});
