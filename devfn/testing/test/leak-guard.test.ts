// The DevFn test leak guard (devfn/test-support/leak-guard.mjs) fails a run that leaves a
// process or temp directory behind, and still removes them. Each case runs a small guarded
// Vitest project in a child process and checks its exit, its report and what is left.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { withFileLock } from "@devfn/ports";

import { ORIGINAL_TEMP_VARIABLE, ownedProcesses, pathsNamedUnder } from "../../test-support/leak-guard.mjs";
import { temporaryDirectories } from "../../test-support/temp-directories.mjs";

const tempDir = temporaryDirectories(afterEach);
const guard = fileURLToPath(new URL("../../test-support/leak-guard.mjs", import.meta.url));
const locks = fileURLToPath(new URL("../../test-support/shared-locks.mjs", import.meta.url));
const vitest = path.join(path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Whether the process has gone within a short while: a killed orphan is reaped by init.
const gone = async (pid: number) => {
  for (const deadline = Date.now() + 2_000; alive(pid) && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 50));
  return !alive(pid);
};

// A detached process with no inherited environment, as a DevFn wrapper is, kept alive.
const leakProcess = (cwd: string) => `(() => {
  const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", cwd: ${cwd}, env: { PATH: process.env.PATH } });
  child.unref();
  return child.pid;
})()`;

// The same process, started through a short-lived parent so that it is orphaned (re-parented to
// init) at once, as a DevFn wrapper is once the command that started it exits.
// With `named`, the orphan's command line also names that path.
const orphanProcess = (cwd: string, named = '""') => `(() => {
  const start = 'const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...process.argv.slice(2).filter(Boolean)], { detached: true, stdio: "ignore", cwd: process.argv[1], env: { PATH: process.env.PATH } }); child.unref(); process.stdout.write(String(child.pid));';
  return Number(require("node:child_process").spawnSync(process.execPath, ["-e", start, ${cwd}, ${named}], { encoding: "utf8", env: { PATH: process.env.PATH } }).stdout);
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
 * closes the task's output and sends SIGINT to its process group. With `duringTeardown`, the
 * interruption waits until every test has finished and Vitest has printed its summary, when
 * the guard's run teardown is waiting for leftover processes to exit. `env` adds variables.
 */
async function runProject(dir: string, record: string, interrupt?: "signal" | "cancel", { duringTeardown = false, env = {} }: { duringTeardown?: boolean; env?: Record<string, string> } = {}): Promise<{ code: number | null; output: string; recorded: { root: string; pid?: number; dir?: string; child?: number; sibling?: number; nested?: number } }> {
  const child = spawn(process.execPath, [vitest, "run", "--root", dir, "--config", path.join(dir, "vitest.config.mjs")],
    { cwd: dir, detached: interrupt === "cancel", env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...env } });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code, signal) => resolve(code ?? (signal ? -1 : null))));
  if (interrupt) {
    while (!existsSync(record)) await new Promise((resolve) => setTimeout(resolve, 50));
    if (duringTeardown) {
      while (!/Test Files\s/.test(output)) await new Promise((resolve) => setTimeout(resolve, 50));
      // The teardown waits RUN_GRACE_MS (5 s) for leftovers to exit; this lands well inside it.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
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

describe("pathsNamedUnder", () => {
  const root = "/tmp/review-repo";
  it.each([
    ["a path separator", `node ${root}/server.mjs`, `${root}/server.mjs`],
    ["a trailing path separator", `node ${root}/`, root],
    ["a KEY= assignment", `TMPDIR=${root} HOME=/home/x`, root],
    ["an --option= assignment", `node --state-dir=${root}/state`, `${root}/state`],
    ["a : list separator", `PATH=/usr/bin:${root}:/bin`, root],
    ["a space", `node ${root} --flag`, root],
    ["a quote", `sh -c "node '${root}/server.mjs'"`, `${root}/server.mjs`],
    ["the end of the text", `cd ${root}`, root],
    ["a file URL", `node --import=file://${root}/loader.mjs`, `${root}/loader.mjs`],
  ])("names a path under the root when it is a complete value, with %s", (_, text, named) => {
    expect(pathsNamedUnder(text, root)).toEqual([named]);
  });

  it("names a path under a root with a space in it", () => {
    expect(pathsNamedUnder("node /tmp/my repo/server.mjs", "/tmp/my repo")).toEqual(["/tmp/my repo/server.mjs"]);
  });

  // Each of these characters can be part of a file name, so the value is a sibling path.
  const siblings = ["[", "é", "-", ".", "+", ";", ",", "(", ")", "&", "|", "<", ">", "="].map((suffix) => [suffix, `${root}${suffix}other`]);
  it.each([
    ...siblings.map(([suffix, sibling]) => [suffix, `node ${sibling}/server.mjs`]),
    ["a longer path that only ends with the root", `node /srv${root}/server.mjs`],
    ["a shell command before it", `sh -c cd;${root}/server.mjs`],
  ])("names no path under the root for a value that continues with %s", (_, text) => {
    expect(pathsNamedUnder(text, root)).toEqual([]);
  });

  it("keeps an argument or variable whole where the listing separates them with NUL, as Linux's /proc does", () => {
    expect(pathsNamedUnder(`node\0${root} sibling/x\0`, root, { separated: true })).toEqual([]);
    expect(pathsNamedUnder(`TMPDIR=${root} sibling\0HOME=/home/x\0`, root, { separated: true })).toEqual([]);
    expect(pathsNamedUnder(`node\0${root}/server.mjs\0--flag\0`, root, { separated: true })).toEqual([`${root}/server.mjs`]);
    expect(pathsNamedUnder(`HOME=/home/x\0TMPDIR=${root}\0`, root, { separated: true })).toEqual([root]);
    expect(pathsNamedUnder("node\0/tmp/my repo/server.mjs\0", "/tmp/my repo", { separated: true })).toEqual(["/tmp/my repo/server.mjs"]);
    const listed = (pid: number, argv: string, environment = "") => ({ pid, ppid: 1, pgid: pid, elapsed: 0, command: argv.replaceAll("\0", " ").trim(), argv, environment, separated: true, cwd: undefined });
    const owned = listed(9_000_201, `node\0${root}/server.mjs\0`);
    const foreign = [listed(9_000_202, `node\0${root} sibling/server.mjs\0`), listed(9_000_203, "node\0server.mjs\0", `TMPDIR=${root} sibling\0`)];
    expect(ownedProcesses([owned, ...foreign], { roots: [root] }).map(({ pid }) => pid)).toEqual([owned.pid]);
  });

  it("decides which processes a run or registered directory owns, and so may signal, on complete path values", () => {
    const entry = (pid: number, command: string, environment = "", cwd?: string) => ({ pid, ppid: 1, pgid: pid, elapsed: 0, command, environment, cwd });
    const owned = [
      entry(9_000_001, `node ${root}/server.mjs`),
      entry(9_000_002, "node server.mjs", `TMPDIR=${root} HOME=/home/x`),
      entry(9_000_003, "node server.mjs", "", `${root}/package`),
      entry(9_000_004, `node --state-dir=${root}/state server.mjs`),
      entry(9_000_005, "node server.mjs", `PATH=/usr/bin:${root}/bin`),
    ];
    const foreign = siblings.flatMap(([, sibling], index) => [
      entry(9_000_100 + 3 * index, `node ${sibling}/server.mjs`),
      entry(9_000_101 + 3 * index, "node server.mjs", `TMPDIR=${sibling} HOME=/home/x`),
      entry(9_000_102 + 3 * index, "node server.mjs", "", sibling),
    ]);
    expect(ownedProcesses([...owned, ...foreign], { roots: [root] }).map(({ pid }) => pid)).toEqual(owned.map(({ pid }) => pid));
  });
});

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

  // A detached group leader whose SIGTERM handler starts two processes and exits: one in its own
  // group that names no path of the run, which only killing the group stops, and one detached in
  // a group of its own in the leader's working directory, which only listing again finds.
  it.each([
    ["the run's temp root, where only the run's teardown finds it", "process.env.SFN_TEST_LEAK_GUARD_ROOT"],
    ["its test file's folder", 'mkdtempSync(path.join(tmpdir(), "devfn-leader-"))'],
  ])("stops what a leftover process starts as it is stopped, left in %s", async (_, where) => {
    const { dir, record } = project("");
    const leader = path.join(dir, "leader.cjs");
    const stopped = path.join(dir, "stopped.json");
    writeFileSync(leader, `const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {
  const keep = [process.execPath, ["-e", "setInterval(() => {}, 1000)"]];
  const sameGroup = spawn(...keep, { stdio: "ignore", cwd: "/", env: { PATH: process.env.PATH } });
  const ownGroup = spawn(...keep, { detached: true, stdio: "ignore", env: { PATH: process.env.PATH } });
  require("node:fs").writeFileSync(process.argv[2], JSON.stringify({ sameGroup: sameGroup.pid, ownGroup: ownGroup.pid }));
  process.exit(0);
});
setInterval(() => {}, 1000);
`);
    writeFileSync(path.join(dir, "fixture.test.mjs"), `${readFileSync(path.join(dir, "fixture.test.mjs"), "utf8")}
test("leaves a process that starts more as it stops", async () => {
  const start = 'const child = require("node:child_process").spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: "ignore", env: { PATH: process.env.PATH } }); child.unref(); process.stdout.write(String(child.pid));';
  const pid = Number(require("node:child_process").spawnSync(process.execPath, ["-e", start, ${JSON.stringify(leader)}, ${JSON.stringify(stopped)}], { cwd: ${where}, encoding: "utf8", env: { PATH: process.env.PATH } }).stdout);
  record({ pid });
  // Long enough for the leader to install its SIGTERM handler.
  await sleep(500);
});`);
    let started: { sameGroup: number; ownGroup: number } | undefined;
    try {
      const { code, output, recorded } = await runProject(dir, record);
      started = JSON.parse(readFileSync(stopped, "utf8"));
      expect(code).not.toBe(0);
      expect(output).toContain(`process ${recorded.pid} `);
      expect(await gone(recorded.pid!)).toBe(true);
      expect(await gone(started!.sameGroup)).toBe(true);
      expect(await gone(started!.ownGroup)).toBe(true);
      expect(existsSync(recorded.root)).toBe(false);
    } finally {
      for (const pid of [started?.sameGroup, started?.ownGroup]) if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* stopped */ }
    }
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

  // The process escapes the file's folder, so only the run's teardown finds it, and keeps running
  // until the teardown's settle window ends; the run is interrupted inside that window.
  const escapes = `test("leaks into the run root", () => {
  record({ pid: ${orphanProcess("process.env.SFN_TEST_LEAK_GUARD_ROOT")} });
});`;

  it("still stops, removes and reports everything when the run is interrupted during its teardown", async () => {
    const { dir, record } = project(escapes);
    const { code, output, recorded } = await runProject(dir, record, "signal", { duringTeardown: true });
    expect(code).not.toBe(0);
    expect(output).toContain("DevFn test leak guard: This interrupted test run left these behind.");
    expect(output).toContain(`process ${recorded.pid} `);
    expect(alive(recorded.pid!)).toBe(false);
    expect(existsSync(recorded.root)).toBe(false);
  });

  it("still stops and removes everything when the run is cancelled with its output closed during its teardown", async () => {
    const { dir, record } = project(escapes);
    const { code, recorded } = await runProject(dir, record, "cancel", { duringTeardown: true });
    expect(code).not.toBe(0);
    expect(alive(recorded.pid!)).toBe(false);
    expect(existsSync(recorded.root)).toBe(false);
  });

  // Permissions do not stop root from removing the folder.
  it.skipIf(process.getuid?.() === 0)("fails a run whose temp root cannot be removed and names it", async () => {
    // The run's temp folder is made read-only once the run has started, so its root cannot be unlinked from it.
    const parent = tempDir("devfn-leak-guard-parent-");
    const { dir, record } = project(`test("locks the temp folder", () => {
  require("node:fs").chmodSync(path.dirname(process.env.SFN_TEST_LEAK_GUARD_ROOT), 0o500);
  record({});
});`);
    try {
      const { code, output, recorded } = await runProject(dir, record, undefined, { env: { TMPDIR: parent, TMP: parent, TEMP: parent } });
      expect(path.dirname(recorded.root)).toBe(parent);
      expect(code, output).not.toBe(0);
      expect(output).toContain(`temp entry ${recorded.root}, the run's temp root, which could not be removed`);
      expect(existsSync(recorded.root)).toBe(true);
    } finally {
      chmodSync(parent, 0o700);
    }
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

  // Where machineLockPath puts a lock for a nested run: in the outermost run's original temp folder.
  const machineLock = (name: string) => path.join(process.env[ORIGINAL_TEMP_VARIABLE] || tmpdir(), name);

  // An owner record as withFileLock (@devfn/ports) writes it, taken from inside a guarded test.
  const takeLock = (lock: string) => `const { machineLockPath } = await import(${JSON.stringify(locks)});
const lock = machineLockPath(${JSON.stringify(lock)});
mkdirSync(lock);
writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ token: "fixture", pid: process.pid, createdAt: new Date().toISOString() }));`;

  it("removes a machine-wide lock whose holder an interrupted run killed, so the next run takes it at once", async () => {
    const name = `devfn-leak-guard-lock-${randomUUID()}`;
    const lock = machineLock(name);
    const { dir, record } = project(`test("holds the lock and hangs", async () => {
  ${takeLock(name)}
  record({ pid: process.pid, dir: lock });
  await new Promise(() => {});
}, 60_000);`);
    try {
      const { code, output, recorded } = await runProject(dir, record, "signal");
      expect(code).not.toBe(0);
      expect(recorded.dir).toBe(lock);
      expect(alive(recorded.pid!)).toBe(false);
      expect(output).toContain(`${lock}, a machine-wide lock held by process ${recorded.pid}, which ended without releasing it`);
      expect(existsSync(lock)).toBe(false);
      expect(existsSync(recorded.root)).toBe(false);
      // Before, the dead holder's lock blocked every taker until it was 300 s old.
      await expect(withFileLock(lock, async () => "taken", { timeoutMs: 2_000 })).resolves.toBe("taken");
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  });

  it("removes and lists a machine-wide lock whose holder died without releasing it before the run ended", async () => {
    const name = `devfn-leak-guard-lock-${randomUUID()}`;
    const lock = machineLock(name);
    const { dir, record } = project(`test("holds the lock and dies", async () => {
  ${takeLock(name)}
  record({ pid: process.pid });
  process.kill(process.pid, "SIGKILL");
});`);
    try {
      const { code, output, recorded } = await runProject(dir, record);
      expect(code).not.toBe(0);
      // Vitest ends the run as soon as a worker dies, through the guard's exit cleanup.
      expect(output).toContain("DevFn test leak guard: This interrupted test run left these behind.");
      expect(output).toContain(`${lock}, a machine-wide lock held by process ${recorded.pid}, which ended without releasing it`);
      expect(existsSync(lock)).toBe(false);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  });

  it("leaves alone a machine-wide lock a run's test named but another process holds, running or not", async () => {
    // Held by this process, still running, and by a process that has exited but was never the run's.
    const exited = spawnSync(process.execPath, ["-e", ""]).pid;
    const held = [process.pid, exited].map((pid) => {
      const name = `devfn-leak-guard-lock-${randomUUID()}`;
      const lock = machineLock(name);
      mkdirSync(lock);
      writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ token: "foreign", pid, createdAt: new Date(Date.now() + 60_000).toISOString() }));
      return { name, lock };
    });
    const namesLocks = (then: string) => `const { machineLockPath } = await import(${JSON.stringify(locks)});
test("names the locks", async () => {
  for (const name of ${JSON.stringify(held.map(({ name }) => name))}) expect(existsSync(machineLockPath(name))).toBe(true);
  record({});
  ${then}
}, 60_000);`;
    try {
      // When the run is interrupted, and when it ends.
      const interrupted = project(namesLocks("await new Promise(() => {});"));
      const { code, output } = await runProject(interrupted.dir, interrupted.record, "signal");
      expect(code).not.toBe(0);
      expect(output).not.toContain("machine-wide lock");
      for (const { lock } of held) expect(existsSync(path.join(lock, "owner.json"))).toBe(true);
      const ended = project(namesLocks(""));
      const { code: passed, output: passOutput } = await runProject(ended.dir, ended.record);
      expect(passed, passOutput).toBe(0);
      for (const { lock } of held) expect(existsSync(path.join(lock, "owner.json"))).toBe(true);
    } finally {
      for (const { lock } of held) rmSync(lock, { recursive: true, force: true });
    }
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

  it("reports a worktree orphan but not one in a sibling directory whose name extends the worktree's, or in a checkout nested in it", async () => {
    // Run from the main checkout, a worktree under its .worktrees is someone else's checkout, as is
    // /x/repo-dev-42 beside /x/repo. Orphans there are not this run's and must not fail it.
    const { dir, record } = project(`test("orphans in and beside the worktree", () => {
  const sibling = process.cwd() + "-sibling";
  const nested = path.join(process.cwd(), ".worktrees", "other", "package");
  const own = path.join(process.cwd(), "package");
  record({
    sibling: ${orphanProcess("sibling", 'path.join(sibling, "server.mjs")')},
    nested: ${orphanProcess("nested", 'path.join(nested, "server.mjs")')},
    pid: ${orphanProcess("own", 'path.join(own, "server.mjs")')},
  });
});`);
    mkdirSync(path.join(dir, ".git"));
    mkdirSync(path.join(dir, "package"));
    mkdirSync(path.join(dir, ".worktrees", "other", "package"), { recursive: true });
    writeFileSync(path.join(dir, ".worktrees", "other", ".git"), "gitdir: elsewhere\n");
    mkdirSync(`${dir}-sibling`);
    let recorded: { root: string; pid?: number; sibling?: number; nested?: number } | undefined;
    try {
      const result = await runProject(dir, record);
      recorded = result.recorded;
      expect(result.code).not.toBe(0);
      expect(result.output).toContain(`run from or name a path in the worktree ${realpathSync(dir)}, and were orphaned.`);
      expect(result.output).toContain(`process ${recorded!.pid} `);
      expect(result.output).not.toContain(`process ${recorded!.sibling} `);
      expect(result.output).not.toContain(`process ${recorded!.nested} `);
      for (const pid of [recorded!.pid, recorded!.sibling, recorded!.nested]) expect(alive(pid!)).toBe(true);
    } finally {
      for (const pid of [recorded?.pid, recorded?.sibling, recorded?.nested]) if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      rmSync(`${dir}-sibling`, { recursive: true, force: true });
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
