import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ProcessSupervisor as Supervisor } from "../src/supervisor.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const exists = async (file: string) => await stat(file).then(() => true, () => false);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A run launches the compiled wrapper next to the supervisor, which the
// package's own build may not provide yet, so its sources are transpiled
// next to each other, where @devfn/config still resolves.
let dir: string;
let ProcessSupervisor: typeof Supervisor;
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
