// The DevFn test leak guard (devfn/test-support/leak-guard.mjs) fails a run that leaves a
// process or temp directory behind, and still removes them. Each case runs a small guarded
// Vitest project in a child process and checks its exit, its report and what is left.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { temporaryDirectories } from "../../test-support/temp-directories.mjs";

const tempDir = temporaryDirectories(afterEach);
const guard = fileURLToPath(new URL("../../test-support/leak-guard.mjs", import.meta.url));
const locks = fileURLToPath(new URL("../../test-support/shared-locks.mjs", import.meta.url));
const vitest = path.join(path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A detached process with no inherited environment, as a DevFn wrapper is, kept alive.
const leakProcess = (cwd: string) => `(() => {
  const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", cwd: ${cwd}, env: { PATH: process.env.PATH } });
  child.unref();
  return child.pid;
})()`;

// The same process, started through a short-lived parent so that it is orphaned (re-parented to
// init) at once, as a DevFn wrapper is once the command that started it exits.
const orphanProcess = (cwd: string) => `(() => {
  const start = 'const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", cwd: process.argv[1], env: { PATH: process.env.PATH } }); child.unref(); process.stdout.write(String(child.pid));';
  return Number(require("node:child_process").spawnSync(process.execPath, ["-e", start, ${cwd}], { encoding: "utf8", env: { PATH: process.env.PATH } }).stdout);
})()`;

/**
 * Writes a guarded Vitest project whose test file has the given body, with more test files
 * when `files` names them and extra test options when `options` lists them.
 */
function project(body: string, { files = {}, options = "" }: { files?: Record<string, string>; options?: string } = {}): { dir: string; record: string } {
  const dir = tempDir("devfn-leak-guard-project-");
  const record = path.join(dir, "record.json");
  writeFileSync(path.join(dir, "vitest.config.mjs"), `export default { test: { include: ["*.test.mjs"], globals: true, testTimeout: 1000, globalSetup: [${JSON.stringify(guard)}], setupFiles: ["./setup.mjs"]${options} } };\n`);
  writeFileSync(path.join(dir, "setup.mjs"), `import { guardTestFile } from ${JSON.stringify(guard)};\nguardTestFile({ beforeEach, afterEach, afterAll });\n`);
  for (const [name, content] of Object.entries({ "fixture.test.mjs": body, ...files })) {
    writeFileSync(path.join(dir, name), `const require = (await import("node:module")).createRequire(import.meta.url);
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const record = (value) => writeFileSync(${JSON.stringify(record)}, JSON.stringify({ root: process.env.SFN_TEST_LEAK_GUARD_ROOT, ...value }));
${content}
`);
  }
  return { dir, record };
}

/**
 * Runs the project. Once the fixture has recorded what it started, `"signal"` sends Vitest
 * SIGTERM, and `"cancel"` cancels it the way turbo cancels a task when a sibling fails: it
 * closes the task's output and sends SIGINT to its process group.
 */
async function runProject(dir: string, record: string, interrupt?: "signal" | "cancel"): Promise<{ code: number | null; output: string; recorded: { root: string; pid?: number; dir?: string; child?: number } }> {
  const child = spawn(process.execPath, [vitest, "run", "--root", dir, "--config", path.join(dir, "vitest.config.mjs")],
    { cwd: dir, detached: interrupt === "cancel", env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code, signal) => resolve(code ?? (signal ? -1 : null))));
  if (interrupt) {
    while (!existsSync(record)) await new Promise((resolve) => setTimeout(resolve, 50));
    if (interrupt === "signal") child.kill("SIGTERM");
    else {
      child.stdout.destroy();
      child.stderr.destroy();
      process.kill(-child.pid!, "SIGINT");
    }
  }
  const code = await exited;
  return { code, output, recorded: JSON.parse(readFileSync(record, "utf8")) };
}

// The guard lists processes on Linux and macOS, and the fixtures stop process groups.
describe.skipIf(process.platform === "win32")("DevFn test leak guard", { timeout: 60_000 }, () => {
  it("passes a run whose tests stop what they start and remove what they create", async () => {
    const { dir, record } = project(`test("cleans up", async () => {
  const folder = mkdtempSync(path.join(tmpdir(), "devfn-clean-"));
  const pid = ${leakProcess("folder")};
  record({ pid, dir: folder });
  process.kill(-pid, "SIGKILL");
  while (true) { try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 20)); } catch { break; } }
  require("node:fs").rmSync(folder, { recursive: true });
});`);
    const { code, output, recorded } = await runProject(dir, record);
    expect(code, output).toBe(0);
    expect(output).not.toContain("leak guard");
    expect(existsSync(recorded.root)).toBe(false);
  });

  it("fails a test file that leaves a detached process and a temp directory behind, lists them and removes them", async () => {
    const { dir, record } = project(`test("leaks", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "devfn-leaked-"));
  record({ pid: ${leakProcess("folder")}, dir: folder });
});`);
    const { code, output, recorded } = await runProject(dir, record);
    expect(code).not.toBe(0);
    expect(output).toContain(`DevFn test leak guard: ${path.join(dir, "fixture.test.mjs")} left these behind.`);
    expect(output).toContain(`process ${recorded.pid} `);
    expect(output).toContain(`temp entry ${recorded.dir}`);
    expect(alive(recorded.pid!)).toBe(false);
    expect(existsSync(recorded.dir!)).toBe(false);
    expect(existsSync(recorded.root)).toBe(false);
  });

  it("fails the run when a process escapes its test file's folder but still runs from the run's temp root", async () => {
    // The process carries neither the file's folder nor its marker and is no longer the worker's child, so only the post-run check sees it.
    const { dir, record } = project(`test("leaks into the run root", () => {
  record({ pid: ${orphanProcess("process.env.SFN_TEST_LEAK_GUARD_ROOT")} });
});`);
    const { code, output, recorded } = await runProject(dir, record);
    expect(code).not.toBe(0);
    expect(output).toContain(`DevFn test leak guard: This test run (temp root ${recorded.root}) left these behind.`);
    expect(output).toContain(`process ${recorded.pid} `);
    expect(alive(recorded.pid!)).toBe(false);
    expect(existsSync(recorded.root)).toBe(false);
  });

  it("stops what a timed-out test started before the next test runs, although its finally never ran", async () => {
    const { dir, record } = project(`let pid;
test("times out", async () => {
  const folder = mkdtempSync(path.join(tmpdir(), "devfn-timeout-"));
  pid = ${leakProcess("folder")};
  record({ pid, dir: folder });
  try { await new Promise(() => {}); } finally { /* only runs once the stalled call settles */ }
});
test("finds it stopped", () => {
  expect(() => process.kill(pid, 0)).toThrow();
});`);
    const { code, output, recorded } = await runProject(dir, record);
    expect(code).not.toBe(0);
    expect(output).toMatch(/1 failed \| 1 passed/);
    expect(output).not.toContain("leak guard");
    expect(alive(recorded.pid!)).toBe(false);
    expect(existsSync(recorded.dir!)).toBe(false);
  });

  it("fails a test file that leaves a directory it asked the guard to watch outside the temp folder", async () => {
    const outside = tempDir("devfn-leak-guard-outside-");
    const { dir, record } = project(`import { guardDirectory } from ${JSON.stringify(guard)};
test("leaves a guarded directory", () => {
  const folder = mkdtempSync(path.join(${JSON.stringify(outside)}, "cache-"));
  guardDirectory(folder);
  record({ pid: ${leakProcess("folder")}, dir: folder });
});`);
    const { code, output, recorded } = await runProject(dir, record);
    expect(code).not.toBe(0);
    expect(output).toContain(`process ${recorded.pid} `);
    expect(output).toContain(`temp entry ${recorded.dir}`);
    expect(alive(recorded.pid!)).toBe(false);
    expect(existsSync(recorded.dir!)).toBe(false);
  });

  const hangs = `test("hangs", async () => {
  const folder = mkdtempSync(path.join(tmpdir(), "devfn-interrupted-"));
  record({ pid: ${leakProcess("folder")}, dir: folder });
  await new Promise(() => {});
}, 60_000);`;

  it("stops what an interrupted run started, lists it and removes its temp root", async () => {
    const { dir, record } = project(hangs);
    const { code, output, recorded } = await runProject(dir, record, "signal");
    expect(code).not.toBe(0);
    expect(output).toContain("DevFn test leak guard: This interrupted test run left these behind.");
    expect(output).toContain(`process ${recorded.pid} `);
    expect(alive(recorded.pid!)).toBe(false);
    expect(existsSync(recorded.root)).toBe(false);
  });

  it("stops what a run started when it is cancelled with its output already closed", async () => {
    const { dir, record } = project(hangs);
    const { code, recorded } = await runProject(dir, record, "cancel");
    expect(code).not.toBe(0);
    expect(alive(recorded.pid!)).toBe(false);
    expect(existsSync(recorded.root)).toBe(false);
  });

  it("stops what an interrupted run started from a directory a test registered outside the temp folder, though it was orphaned", async () => {
    // The process carries no marker and is no longer the worker's child: only the directory's
    // registration in the run's root ties it to the run once the worker is gone.
    const outside = tempDir("devfn-leak-guard-outside-");
    const { dir, record } = project(`import { guardDirectory } from ${JSON.stringify(guard)};
test("hangs", async () => {
  const folder = mkdtempSync(path.join(${JSON.stringify(outside)}, "cache-"));
  guardDirectory(folder);
  record({ pid: ${orphanProcess("folder")}, dir: folder });
  await new Promise(() => {});
}, 60_000);`);
    const { code, output, recorded } = await runProject(dir, record, "signal");
    expect(code).not.toBe(0);
    expect(output).toContain(`process ${recorded.pid} `);
    expect(alive(recorded.pid!)).toBe(false);
    expect(existsSync(recorded.dir!)).toBe(false);
    expect(existsSync(recorded.root)).toBe(false);
  });

  it("stops a process a test file started with no trace of the run, and fails the run on an orphan in the worktree without signalling it", async () => {
    // Both run from the worktree with only PATH. The worker's own child is the file's; the orphan
    // cannot be attributed to the run, so the run fails and lists it, but leaves it running.
    const { dir, record } = project(`test("leaks into the worktree", () => {
  const folder = path.join(process.cwd(), "package");
  record({ child: ${leakProcess("folder")}, pid: ${orphanProcess("folder")} });
});`);
    mkdirSync(path.join(dir, ".git"));
    mkdirSync(path.join(dir, "package"));
    let orphan: number | undefined;
    try {
      const { code, output, recorded } = await runProject(dir, record);
      orphan = recorded.pid;
      expect(code).not.toBe(0);
      expect(output).toContain(`DevFn test leak guard: ${path.join(dir, "fixture.test.mjs")} left these behind.`);
      expect(output).toContain(`process ${recorded.child} `);
      expect(alive(recorded.child!)).toBe(false);
      expect(output).toContain(`run from or name a path in the worktree ${realpathSync(dir)}, and were orphaned.`);
      expect(output).toContain(`process ${orphan} `);
      expect(alive(orphan!)).toBe(true);
      expect(existsSync(recorded.root)).toBe(false);
    } finally {
      if (orphan) try { process.kill(orphan, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("gives test files that run at once, each with its own temp folder, the same machine-wide lock", async () => {
    const signals = tempDir("devfn-leak-guard-signals-");
    const shared = `import { machineLockPath } from ${JSON.stringify(locks)};
const lock = machineLockPath(${JSON.stringify(`devfn-leak-guard-lock-${randomUUID()}`)});
const signal = (name) => path.join(${JSON.stringify(signals)}, name);`;
    const { dir, record } = project(`${shared}
test("holds the lock until the other file finds it taken", async () => {
  mkdirSync(lock);
  writeFileSync(signal("held"), tmpdir());
  record({});
  try { while (!existsSync(signal("contended"))) await sleep(20); } finally { rmdirSync(lock); }
}, 20_000);`, { options: ", fileParallelism: true, minWorkers: 2, maxWorkers: 2", files: { "other.test.mjs": `${shared}
test("finds the lock taken while the other file holds it", async () => {
  while (!existsSync(signal("held"))) await sleep(20);
  expect(readFileSync(signal("held"), "utf8")).not.toBe(tmpdir());
  expect(() => mkdirSync(lock)).toThrow(expect.objectContaining({ code: "EEXIST" }));
  writeFileSync(signal("contended"), "");
  while (true) { try { mkdirSync(lock); break; } catch { await sleep(20); } }
  rmdirSync(lock);
}, 20_000);` } });
    const { code, output } = await runProject(dir, record);
    expect(code, output).toBe(0);
    expect(existsSync(path.join(signals, "contended"))).toBe(true);
  });
});
