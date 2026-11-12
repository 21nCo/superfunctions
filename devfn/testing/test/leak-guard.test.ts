// The DevFn test leak guard (devfn/test-support/leak-guard.mjs) fails a run that leaves a
// process or temp directory behind, and still removes them. Each case runs a small guarded
// Vitest project in a child process and checks its exit, its report and what is left.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { withFileLock } from "@devfn/ports";

import { attributeProcesses, ORIGINAL_TEMP_VARIABLE, ownedProcesses, pathsNamedUnder } from "../../test-support/leak-guard.mjs";
import { temporaryDirectories } from "../../test-support/temp-directories.mjs";

const tempDir = temporaryDirectories(afterEach);
const guard = fileURLToPath(new URL("../../test-support/leak-guard.mjs", import.meta.url));
const locks = fileURLToPath(new URL("../../test-support/shared-locks.mjs", import.meta.url));
const vitest = path.join(path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");

// Whether the process runs: an unreaped zombie, which a container's PID 1 may leave, does not.
// Read from /proc on Linux and ps on macOS, independently of the guard's own listing.
const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform === "linux") {
    try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return !/^[ZX]/.test(stat.slice(stat.lastIndexOf(")") + 2)); } catch { return false; }
  }
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return state !== "" && !state.startsWith("Z");
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Whether the process has gone within a short while: a killed orphan is reaped by init.
const gone = async (pid: number) => {
  for (const deadline = Date.now() + 2_000; alive(pid) && Date.now() < deadline;) await sleep(50);
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
async function runProject(dir: string, record: string, interrupt?: "signal" | "cancel", { duringTeardown = false, env = {} }: { duringTeardown?: boolean; env?: Record<string, string> } = {}): Promise<{ code: number | null; output: string; recorded: { root: string; pid?: number; dir?: string; child?: number; siblings?: number[]; nested?: number } }> {
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

  it("splits a Linux argument at nothing but its assignment prefix, and a variable at ':' only when it is known to hold a list", () => {
    const listed = (pid: number, argv: string, environment = "") => ({ pid, ppid: 1, pgid: pid, elapsed: 0, command: argv.replaceAll("\0", " ").trim(), argv, environment, separated: true, cwd: "/" });
    const owned = [
      listed(9_000_301, `node\0${root}/server.mjs\0`),
      listed(9_000_302, `node\0--state-dir=${root}/s\0`),
      listed(9_000_303, "node\0", `NODE_PATH=/a:${root}/lib\0`),
      listed(9_000_304, "node\0", `PATH=${root}/bin:/usr/bin\0`),
    ];
    const foreign = [
      listed(9_000_311, `node\0${root}:sibling/x\0`),
      listed(9_000_312, `node\0--dir=${root}:sibling\0`),
      listed(9_000_313, "node\0", `TMPDIR=${root}:sibling\0PATH=/usr/bin\0`),
      // Names ending in PATH that hold a single path.
      listed(9_000_314, "node\0", `DOCKER_CERT_PATH=${root}:sibling/certs\0`),
      listed(9_000_315, "node\0", `ARTIFACT_PATH=${root}:sibling\0`),
    ];
    expect(ownedProcesses([...owned, ...foreign], { roots: [root] }).map(({ pid }) => pid)).toEqual(owned.map(({ pid }) => pid));
  });

  it("never owns a macOS process whose only link is the root cut short at a separator, whether or not the longer path exists", () => {
    const parent = tempDir("devfn-leak-guard-beside-");
    const run = path.join(parent, "run");
    mkdirSync(run);
    const entry = (pid: number, command: string, environment = "", cwd?: string) => ({ pid, ppid: 1, pgid: pid, elapsed: 0, command, environment, cwd });
    const cut = [
      entry(9_000_401, `node ${run} sibling/x`), entry(9_000_402, `node ${run}:sibling/x`), entry(9_000_403, `node '${run}'sibling/x`),
      entry(9_000_404, "node server.mjs", `TMPDIR=${run} HOME=/home/x`),
    ];
    expect(attributeProcesses(cut, { roots: [run] })).toEqual({ owned: [], ambiguous: cut });
    for (const name of ["run sibling", "run:sibling", "run'sibling"]) mkdirSync(path.join(parent, name));
    expect(attributeProcesses(cut, { roots: [run] })).toEqual({ owned: [], ambiguous: cut });
    // A marker, a working directory under the root or a whole path still owns one.
    const corroborated = [
      entry(9_000_411, `node ${run} sibling/x`, "SFN_TEST_LEAK_GUARD_RUN=x"),
      entry(9_000_412, `node ${run} sibling/x`, "", path.join(run, "package")),
      entry(9_000_413, `node ${run}/server.mjs`),
      entry(9_000_414, "node server.mjs", `HOME=/home/x TMPDIR=${run}`),
    ];
    expect(attributeProcesses(corroborated, { roots: [run], marker: "SFN_TEST_LEAK_GUARD_RUN=x" })).toEqual({ owned: corroborated, ambiguous: [] });
  });

  it("decides which processes a run or registered directory owns, and so may signal, on complete path values", () => {
    const entry = (pid: number, command: string, environment = "", cwd?: string) => ({ pid, ppid: 1, pgid: pid, elapsed: 0, command, environment, cwd });
    const owned = [
      entry(9_000_001, `node ${root}/server.mjs`),
      entry(9_000_002, "node server.mjs", `HOME=/home/x TMPDIR=${root}`),
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

  it("fails a test file that leaves a folder named like tsx's cache, which only tsx's exact cache name is exempt from", async () => {
    const { dir, record } = project(`test("leaks a tsx- folder", () => {
  record({ dir: mkdtempSync(path.join(tmpdir(), "tsx-")) });
});`);
    const { code, output, recorded } = await runProject(dir, record);
    expect(code).not.toBe(0);
    expect(output).toContain(`temp entry ${recorded.dir}`);
    expect(existsSync(recorded.dir!)).toBe(false);
  });

  it("fails, but never signals, a process whose only link to the run is its root cut short at a separator", async () => {
    // The orphan names "<root> sibling/x", which need not exist, as one argument. Linux's /proc
    // shows that whole, so it is not the run's at all. macOS's ps cannot show where it ends, so
    // the run fails and lists it.
    const { dir, record } = project(`test("leaves a process naming a path beside the run's root", () => {
  record({ pid: ${orphanProcess('"/"', 'process.env.SFN_TEST_LEAK_GUARD_ROOT + " sibling/x"')} });
});`);
    let recorded: { pid?: number } | undefined;
    try {
      const result = await runProject(dir, record);
      recorded = result.recorded;
      if (process.platform === "darwin") {
        expect(result.code).not.toBe(0);
        expect(result.output).toContain("These processes name one of the run's temp folders only where the process listing cannot show where that value ends");
        expect(result.output).toContain(`process ${recorded.pid} `);
      } else expect(result.code, result.output).toBe(0);
      expect(alive(recorded.pid!)).toBe(true);
    } finally {
      if (recorded?.pid) try { process.kill(recorded.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it.each([
    ["a process", `record({ pid: ${orphanProcess("process.env.SFN_TEST_LEAK_GUARD_ROOT")} });`],
    ["only a temp directory", `record({ dir: mkdtempSync(path.join(process.env.SFN_TEST_LEAK_GUARD_ROOT, "devfn-leaked-")) });`],
  ])("fails a run that leaves %s in its root and exits with success before its teardown, as Vitest does after its teardownTimeout", async (_, leak) => {
    // A global setup listed after the guard's tears down first and ends the process with code 0.
    const { dir, record } = project(`test("leaks into the run root", () => {
  ${leak}
});`, { files: { "exit.mjs": "export default () => () => process.exit(0);" }, options: `, globalSetup: [${JSON.stringify(guard)}, "./exit.mjs"]` });
    const { code, output, recorded } = await runProject(dir, record);
    expect(code).not.toBe(0);
    expect(output).toContain("DevFn test leak guard: This interrupted test run left these behind.");
    expect(output).toContain(recorded.pid ? `process ${recorded.pid} ` : `temp entry ${recorded.dir}`);
    if (recorded.pid) expect(await gone(recorded.pid)).toBe(true);
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

  const ownerRecord = (lock: string) => JSON.parse(readFileSync(path.join(lock, "owner.json"), "utf8"));

  /**
   * Interrupts a run whose test holds a machine-wide lock. The run's cleanup kills the holder and
   * then, once it holds withFileLock's takeover marker for the dead holder's record, pauses (a
   * test-only hook) while `during` runs. A waiter whose staleMs has passed could recover the lock then.
   */
  async function pausedLockCleanup(lock: string, during: (paused: { pid: number }) => Promise<void>, env: Record<string, string> = {}) {
    const release = path.join(tempDir("devfn-leak-guard-pause-"), "release");
    const { dir, record } = project(`test("holds the lock and hangs", async () => {
  ${takeLock(path.basename(lock))}
  record({ pid: process.pid, dir: lock });
  await new Promise(() => {});
}, 60_000);`);
    let ended = false;
    const running = runProject(dir, record, "signal", { env: { ...env, SFN_TEST_LEAK_GUARD_LOCK_PAUSE: release } }).finally(() => { ended = true; });
    try {
      while (!existsSync(`${release}.held`)) {
        if (ended) throw new Error(`The guard never held the lock's takeover marker:\n${(await running).output}`);
        await sleep(20);
      }
      await sleep(50);
      await during(JSON.parse(readFileSync(`${release}.held`, "utf8")));
    } catch (error) {
      writeFileSync(release, "");
      await running.catch(() => undefined);
      throw error;
    }
    writeFileSync(release, "");
    return await running;
  }

  it("moves a dead holder's lock away holding withFileLock's takeover marker, so a waiter whose staleMs has passed waits and then takes it fresh", async () => {
    const lock = machineLock(`devfn-leak-guard-lock-${randomUUID()}`);
    let waiter: Promise<number> | undefined;
    try {
      const { code, output, recorded } = await pausedLockCleanup(lock, async () => {
        waiter = withFileLock(lock, async () => ownerRecord(lock).pid, { staleMs: 100, timeoutMs: 20_000 });
        await sleep(1_000);
        // Without the guard's marker, the waiter would have replaced the dead holder's record by now.
        expect(ownerRecord(lock)).toMatchObject({ token: "fixture" });
      });
      expect(code).not.toBe(0);
      expect(output).toContain(`${lock}, a machine-wide lock held by process ${recorded.pid}, which ended without releasing it`);
      expect(output).not.toContain("left in place");
      // The waiter then holds a lock of its own, created after the guard freed the path.
      await expect(waiter).resolves.toBe(process.pid);
      expect(existsSync(lock)).toBe(false);
    } finally {
      await waiter?.catch(() => undefined);
      rmSync(lock, { recursive: true, force: true });
    }
  });

  it("leaves in place, and lists, a dead holder's lock that a live waiter holds the takeover marker for", async () => {
    const lock = machineLock(`devfn-leak-guard-lock-${randomUUID()}`);
    const marker = (record: string) => `owner.takeover.${createHash("sha256").update(record).digest("hex").slice(0, 32)}.0`;
    const { dir, record } = project(`test("holds the lock, which a live waiter is taking over, and hangs", async () => {
  ${takeLock(path.basename(lock))}
  const owner = readFileSync(path.join(lock, "owner.json"), "utf8");
  const marker = "owner.takeover." + require("node:crypto").createHash("sha256").update(owner).digest("hex").slice(0, 32) + ".0";
  writeFileSync(path.join(lock, marker), JSON.stringify({ token: "waiter", pid: Number(process.env.LIVE_WAITER), createdAt: new Date().toISOString() }));
  record({ pid: process.pid, dir: lock });
  await new Promise(() => {});
}, 60_000);`);
    try {
      const { code, output, recorded } = await runProject(dir, record, "signal", { env: { LIVE_WAITER: String(process.pid) } });
      expect(code).not.toBe(0);
      expect(alive(recorded.pid!)).toBe(false);
      expect(output).toContain(`${lock}, a machine-wide lock held by process ${recorded.pid}, which ended without releasing it; it was left in place`);
      expect(ownerRecord(lock)).toMatchObject({ token: "fixture", pid: recorded.pid });
      // Only the holder's record and the live waiter's marker: the guard took nothing and left nothing.
      expect(readdirSync(lock).sort()).toEqual(["owner.json", marker(readFileSync(path.join(lock, "owner.json"), "utf8"))].sort());
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  });

  it("leaves a lock whose owner record changed while the guard held its takeover marker, removing only its own files", async () => {
    const lock = machineLock(`devfn-leak-guard-lock-${randomUUID()}`);
    const successor = JSON.stringify({ token: "successor", pid: process.pid, createdAt: new Date().toISOString() });
    try {
      const { code, output } = await pausedLockCleanup(lock, async () => {
        writeFileSync(path.join(lock, "successor.tmp"), successor);
        renameSync(path.join(lock, "successor.tmp"), path.join(lock, "owner.json"));
      });
      expect(code).not.toBe(0);
      expect(output).not.toContain(`${lock}, a machine-wide lock`);
      expect(readFileSync(path.join(lock, "owner.json"), "utf8")).toBe(successor);
      expect(readdirSync(lock)).toEqual(["owner.json"]);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  });

  it("lets withFileLock recover a dead holder's lock past the marker of a guard that died holding it", async () => {
    const lock = machineLock(`devfn-leak-guard-lock-${randomUUID()}`);
    // The killed run leaves its temp root and Vitest's own folder behind, here.
    const parent = tempDir("devfn-leak-guard-parent-");
    try {
      await pausedLockCleanup(lock, async ({ pid }) => { process.kill(pid, "SIGKILL"); }, { TMPDIR: parent, TMP: parent, TEMP: parent });
      expect(ownerRecord(lock)).toMatchObject({ token: "fixture" });
      await expect(withFileLock(lock, async () => ownerRecord(lock).pid, { staleMs: 100, timeoutMs: 10_000 })).resolves.toBe(process.pid);
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

  // Directories beside the worktree whose names continue its name across a separator.
  const besides = ["-sibling", " sibling", ":sibling", "'sibling"];

  it("reports a worktree orphan but not one in a sibling directory whose name extends the worktree's, or in a checkout nested in it", async () => {
    // Run from the main checkout, a worktree under its .worktrees is someone else's checkout, as is
    // /x/repo-dev-42, "/x/repo copy" or /x/repo:x beside /x/repo. Orphans there are not this run's and must not fail it.
    const { dir, record } = project(`test("orphans in and beside the worktree", () => {
  const nested = path.join(process.cwd(), ".worktrees", "other", "package");
  const own = path.join(process.cwd(), "package");
  record({
    siblings: ${JSON.stringify(besides)}.map((suffix) => process.cwd() + suffix).map((sibling) => ${orphanProcess("sibling", 'path.join(sibling, "server.mjs")')}),
    nested: ${orphanProcess("nested", 'path.join(nested, "server.mjs")')},
    pid: ${orphanProcess("own", 'path.join(own, "server.mjs")')},
  });
});`);
    mkdirSync(path.join(dir, ".git"));
    mkdirSync(path.join(dir, "package"));
    mkdirSync(path.join(dir, ".worktrees", "other", "package"), { recursive: true });
    writeFileSync(path.join(dir, ".worktrees", "other", ".git"), "gitdir: elsewhere\n");
    for (const suffix of besides) mkdirSync(`${dir}${suffix}`);
    let recorded: { root: string; pid?: number; siblings?: number[]; nested?: number } | undefined;
    try {
      const result = await runProject(dir, record);
      recorded = result.recorded;
      expect(result.code).not.toBe(0);
      expect(result.output).toContain(`run from or name a path in the worktree ${realpathSync(dir)}, and were orphaned.`);
      expect(result.output).toContain(`process ${recorded!.pid} `);
      for (const pid of [...recorded!.siblings!, recorded!.nested]) expect(result.output).not.toContain(`process ${pid} `);
      for (const pid of [recorded!.pid, ...recorded!.siblings!, recorded!.nested]) expect(alive(pid!)).toBe(true);
    } finally {
      for (const pid of [recorded?.pid, ...(recorded?.siblings ?? []), recorded?.nested]) if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      for (const suffix of besides) rmSync(`${dir}${suffix}`, { recursive: true, force: true });
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
