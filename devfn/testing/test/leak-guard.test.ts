// The DevFn test leak guard (devfn/test-support/leak-guard.mjs) fails a run that leaves a
// process or temp directory behind, and still removes them. Each case runs a small guarded
// Vitest project in a child process and checks its exit, its report and what is left.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { processBirthSignature } from "@devfn/config";
import { withFileLock } from "@devfn/ports";

import { attributeProcesses, listProcesses, ORIGINAL_TEMP_VARIABLE, ownedProcesses, pathAliases, pathsNamedUnder, stopProcesses } from "../../test-support/leak-guard.mjs";
import { temporaryDirectories } from "../../test-support/temp-directories.mjs";

const tempDir = temporaryDirectories(afterEach);
// Processes a fixture leaves on purpose where no guard finds them, read from the files that name
// them and stopped after each test however it ends, a timeout included. Registered after
// temporaryDirectories, so this runs first, while the files are still there.
const fixtureFiles: string[] = [];
afterEach(() => {
  for (const file of fixtureFiles.splice(0)) {
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    const pids = file.endsWith(".json") ? [JSON.parse(text).named] : [Number(text)];
    for (const pid of pids) if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
});
const guard = fileURLToPath(new URL("../../test-support/leak-guard.mjs", import.meta.url));
const locks = fileURLToPath(new URL("../../test-support/shared-locks.mjs", import.meta.url));
const vitest = path.join(path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");

// Whether the process runs: an unreaped zombie, which a container's PID 1 may leave, does not.
// The same check runs in every script this file generates, which require it from here.
const liveness = fileURLToPath(new URL("./liveness.cjs", import.meta.url));
const { live: alive } = createRequire(import.meta.url)(liveness) as { live: (pid: number) => boolean };
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

// A Node process with the given arguments (fixture expressions), started detached through a
// short-lived parent so that it is orphaned (re-parented to init) at once, as a DevFn wrapper is
// once the command that started it exits.
const orphan = (cwd: string, args: string[]) => `(() => {
  const start = 'const child = require("node:child_process").spawn(process.execPath, process.argv.slice(2).filter(Boolean), { detached: true, stdio: "ignore", cwd: process.argv[1], env: { PATH: process.env.PATH } }); child.unref(); process.stdout.write(String(child.pid));';
  return Number(require("node:child_process").spawnSync(process.execPath, ["-e", start, ${[cwd, ...args].join(", ")}], { encoding: "utf8", env: { PATH: process.env.PATH } }).stdout);
})()`;
// Such an orphan kept alive. With `named`, its command line also names those values.
const orphanProcess = (cwd: string, ...named: string[]) => orphan(cwd, ['"-e"', '"setInterval(() => {}, 1000)"', ...named]);

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
const { live } = require(${JSON.stringify(liveness)});
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
async function runProject(dir: string, record: string, interrupt?: "signal" | "cancel", { duringTeardown = false, env = {} }: { duringTeardown?: boolean; env?: Record<string, string> } = {}): Promise<{ code: number | null; output: string; recorded: { root: string; pid?: number; dir?: string; child?: number; named?: number; siblings?: number[]; nested?: number } }> {
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

  it("never owns a process on a path in a macOS listing alone, which cannot show where a value starts or ends, whether or not another path exists", () => {
    const parent = tempDir("devfn-leak-guard-beside-");
    const run = path.join(parent, "run");
    mkdirSync(run);
    const entry = (pid: number, command: string, environment = "", cwd?: string) => ({ pid, ppid: 1, pgid: pid, elapsed: 0, command, environment, cwd });
    const text = [
      entry(9_000_401, `node ${run} sibling/x`), entry(9_000_402, `node ${run}:sibling/x`), entry(9_000_403, `node '${run}'sibling/x`),
      entry(9_000_404, "node server.mjs", `TMPDIR=${run} HOME=/home/x`), entry(9_000_405, "node server.mjs", `HOME=/home/x TMPDIR=${run}`),
      // A whole argument or variable "/foreign <run>/server.mjs" lists the same.
      entry(9_000_406, `node /foreign ${run}/server.mjs`), entry(9_000_407, `node /foreign:${run}/server.mjs`), entry(9_000_408, "node", `CUSTOM=/foreign ${run}/server.mjs`),
    ];
    expect(attributeProcesses(text, { roots: [run] })).toEqual({ owned: [], ambiguous: text });
    for (const name of ["run sibling", "run:sibling", "run'sibling"]) mkdirSync(path.join(parent, name));
    expect(attributeProcesses(text, { roots: [run] })).toEqual({ owned: [], ambiguous: text });
    // A marker, a working directory under the root or other evidence (`vouch`) owns one.
    const corroborated = [
      entry(9_000_411, `node ${run} sibling/x`, "SFN_TEST_LEAK_GUARD_RUN=x"),
      entry(9_000_412, `node ${run} sibling/x`, "", path.join(run, "package")),
      entry(9_000_413, `node ${run}/server.mjs`),
    ];
    expect(attributeProcesses(corroborated, { roots: [run], marker: "SFN_TEST_LEAK_GUARD_RUN=x", vouch: ({ pid }) => pid === 9_000_413 })).toEqual({ owned: corroborated, ambiguous: [] });
  });

  it("resolves '.' and '..' in a path value before deciding that it is under the root, and reports, but never owns, one the system could not follow", () => {
    const linux = (pid: number, argv: string, environment = "") => ({ pid, ppid: 1, pgid: pid, elapsed: 0, command: argv.replaceAll("\0", " ").trim(), argv, environment, separated: true, cwd: "/" });
    const macos = (pid: number, command: string, environment = "") => ({ pid, ppid: 1, pgid: pid, elapsed: 0, command, environment, cwd: undefined });
    const outside = [
      linux(9_000_501, `node\0${root}/../other/server.mjs\0`), linux(9_000_502, "node\0", `TMPDIR=${root}/../other\0`),
      macos(9_000_503, `node ${root}/../other/x`), macos(9_000_504, "node", `TMPDIR=${root}/./../other`),
    ];
    // Through a missing directory or a file, which the system cannot go up from, but Node, which
    // resolves its script lexically, would run under the root.
    const unresolved = [
      linux(9_000_511, `node\0${root}/a/../b/x\0`), macos(9_000_512, `node ${root}/a/../b/x`),
      linux(9_000_513, `node\0/dev/null/../..${root}/server.mjs\0`), linux(9_000_514, "node\0", `TMPDIR=/dev/null/../..${root}\0`),
    ];
    // A macOS listing cannot show where a value starting with /dev/null starts, so it names no root there.
    const unlisted = macos(9_000_515, `node /dev/null/../..${root}/server.mjs`);
    expect(attributeProcesses([...outside, ...unresolved, unlisted], { roots: [root] })).toEqual({ owned: [], ambiguous: unresolved });
    expect(pathsNamedUnder(`node ${root}/./b//c/`, root)).toEqual([`${root}/b/c`]);
  });

  it("resolves '..' through a symbolic link as the system does, so a path that only reads as under the root is not", () => {
    const run = tempDir("devfn-leak-guard-links-");
    const outside = tempDir("devfn-leak-guard-elsewhere-");
    mkdirSync(path.join(outside, "deep"));
    symlinkSync(path.join(outside, "deep"), path.join(run, "link"));
    mkdirSync(path.join(run, "real"));
    writeFileSync(path.join(run, "file.txt"), "");
    const linux = (pid: number, argv: string, environment = "") => ({ pid, ppid: 1, pgid: pid, elapsed: 0, command: argv.replaceAll("\0", " ").trim(), argv, environment, separated: true, cwd: "/" });
    const macos = (pid: number, command: string) => ({ pid, ppid: 1, pgid: pid, elapsed: 0, command, environment: "", cwd: undefined });
    // <run>/link/.. is the outside folder, not <run>.
    // Under the run only as written: through the link the system goes up outside it, and it cannot
    // go up from a file or a missing directory. Reported, never owned.
    const disputed = [
      linux(9_000_601, `node\0${run}/link/../x\0`), linux(9_000_602, "node\0", `TMPDIR=${run}/link/..\0`), macos(9_000_603, `node ${run}/link/../x`),
      linux(9_000_604, `node\0${run}/file.txt/../x\0`), linux(9_000_605, "node\0", `TMPDIR=${run}/file.txt/..\0`), linux(9_000_606, `node\0${run}/missing/../x\0`),
      macos(9_000_607, `node ${run}/file.txt/../x`),
    ];
    const outsideRun = [linux(9_000_608, `node\0${run}/real/../../x\0`), linux(9_000_609, `node\0${run}/link/../../x\0`)];
    const inside = [linux(9_000_611, `node\0${run}/real/../x\0`), linux(9_000_612, "node\0", `TMPDIR=${run}/real/./..\0`), macos(9_000_613, `node ${run}/real/../x`)];
    expect(attributeProcesses([...disputed, ...outsideRun, ...inside], { roots: pathAliases(run) })).toEqual({ owned: inside.slice(0, 2), ambiguous: [...disputed, inside[2]] });
  });

  it("reads a file: URL as a URL, owns a path only when every reading of it is under the root, and reports one whose value may continue past a macOS separator", () => {
    const run = tempDir("devfn-leak-guard-readings-");
    mkdirSync(path.join(run, "sub"));
    mkdirSync(path.join(run, "deep", "child"), { recursive: true });
    symlinkSync(path.join(run, "deep", "child"), path.join(run, "link"));
    mkdirSync(path.join(run, ".. sibling"));
    const linux = (pid: number, argv: string, environment = "") => ({ pid, ppid: 1, pgid: pid, elapsed: 0, command: argv.replaceAll("\0", " ").trim(), argv, environment, separated: true, cwd: "/" });
    const macos = (pid: number, command: string) => ({ pid, ppid: 1, pgid: pid, elapsed: 0, command, environment: "", cwd: undefined });
    // Percent-encoded dot segments go up out of the root, as Node reads the URL.
    const outside = [
      linux(9_000_701, `node\0file://${run}/%2e%2e/out.mjs\0`), linux(9_000_702, `node\0--import=file://${run}/%2E%2E/out.mjs\0`),
      linux(9_000_703, "node\0", `TMPDIR=file://${run}/%2e%2e\0`), macos(9_000_704, `node file://${run}/%2e%2e/x`),
      // A file: URL without slashes, as macOS lists it too.
      macos(9_000_705, `node --import=file:${run}/%2e%2e/out.mjs`),
    ];
    // <run>/link/../x is <run>/deep/x through the link and <run>/x as written: under the run either way.
    const owned = [linux(9_000_711, `node\0file://${run}/sub/%2e%2e/x.mjs\0`), linux(9_000_712, `node\0${run}/link/../x.mjs\0`)];
    const ambiguous = [
      // A URL Node cannot decode, and a '..' the system cannot follow.
      linux(9_000_721, `node\0file://${run}%2Fx\0`), linux(9_000_722, `node\0${run}/missing/../x\0`),
      // <run>/.. alone is outside the run, but the value may be "<run>/.. sibling/server.mjs".
      macos(9_000_723, `node ${run}/.. sibling/server.mjs`),
      // A scheme in capitals is still a file: URL.
      macos(9_000_724, `node FILE://${run}/x`),
      // The URL may go on past the space, to <run>/.. /server.mjs.
      macos(9_000_725, `node --import=file://${run}/%2e%2e /server.mjs`),
    ];
    expect(attributeProcesses([...outside, ...owned, ...ambiguous], { roots: pathAliases(run) })).toEqual({ owned, ambiguous });
    rmSync(path.join(run, ".. sibling"), { recursive: true });
    expect(attributeProcesses([ambiguous[2]], { roots: pathAliases(run) })).toEqual({ owned: [], ambiguous: [ambiguous[2]] });
  });

  it("decides whether a value names a path under a root only in the guard's path containment section", () => {
    const source = readFileSync(guard, "utf8");
    const start = source.indexOf("// Path containment.");
    const end = source.indexOf("// End of path containment.");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    for (const part of [source.slice(0, start), source.slice(end)]) expect(part).not.toMatch(/isPathUnder\(|startsWith\(`\$\{[^}]*\}\/`\)/);
  });

  it("checks whether a process runs only through the zombie-aware helper, here and in every script this file generates", () => {
    // Sending signal 0 alone succeeds for an unreaped zombie, which a non-reaping PID 1 leaves behind.
    expect(readFileSync(fileURLToPath(import.meta.url), "utf8")).not.toMatch(/\bkill\([^()]*,\s*0\)/);
  });

  it("decides which processes name a path under a run or registered directory on complete path values, and owns from a macOS listing only by working directory", () => {
    const entry = (pid: number, command: string, environment = "", cwd?: string) => ({ pid, ppid: 1, pgid: pid, elapsed: 0, command, environment, cwd });
    const named = [
      entry(9_000_001, `node ${root}/server.mjs`),
      entry(9_000_002, "node server.mjs", `HOME=/home/x TMPDIR=${root}`),
      entry(9_000_004, `node --state-dir=${root}/state server.mjs`),
      entry(9_000_005, "node server.mjs", `PATH=/usr/bin:${root}/bin`),
    ];
    const owned = entry(9_000_003, "node server.mjs", "", `${root}/package`);
    const foreign = siblings.flatMap(([, sibling], index) => [
      entry(9_000_100 + 3 * index, `node ${sibling}/server.mjs`),
      entry(9_000_101 + 3 * index, "node server.mjs", `TMPDIR=${sibling} HOME=/home/x`),
      entry(9_000_102 + 3 * index, "node server.mjs", "", sibling),
    ]);
    expect(attributeProcesses([owned, ...named, ...foreign], { roots: [root] })).toEqual({ owned: [owned], ambiguous: named });
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
  while (live(pid)) await sleep(20);
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

  // A global setup listed after the guard's tears down first and ends the process with code 0.
  const exitsFirst = { files: { "exit.mjs": "export default () => () => process.exit(0);" }, options: `, globalSetup: [${JSON.stringify(guard)}, "./exit.mjs"]` };

  it.each([[false], [true]])("fails a run that leaves an entry named like a test file's folder in its root, exiting first: %s", async (exits) => {
    // Only the folders the guard made for test files are listed by their contents.
    const { dir, record } = project(`test("leaves f- entries", () => {
  mkdirSync(path.join(process.env.SFN_TEST_LEAK_GUARD_ROOT, "f-forgotten"));
  writeFileSync(path.join(process.env.SFN_TEST_LEAK_GUARD_ROOT, "f-result.txt"), "");
  record({});
});`, exits ? exitsFirst : {});
    const { code, output, recorded } = await runProject(dir, record);
    expect(code, output).not.toBe(0);
    for (const name of ["f-forgotten", "f-result.txt"]) expect(output).toContain(`temp entry ${path.join(recorded.root, name)}\n`);
    expect(existsSync(recorded.root)).toBe(false);
  });

  it("lets a process it can only report exit by itself within the same grace as one it would stop", async () => {
    // Each names a temp folder cut short at a space, which a macOS listing cannot tell from the folder itself, and exits within 2 s.
    const { dir, record } = project(`test("leaves short-lived processes naming the file's folder and the run's root", () => {
  for (const folder of [tmpdir(), process.env.SFN_TEST_LEAK_GUARD_ROOT]) ${orphan('"/"', ['"-e"', '"setTimeout(() => {}, 2000)"', 'folder + " sibling/x"'])};
  record({});
});`);
    const { code, output } = await runProject(dir, record);
    expect(code, output).toBe(0);
    expect(output).not.toContain("leak guard");
  });

  it.each([
    ["a process", `record({ pid: ${orphanProcess("process.env.SFN_TEST_LEAK_GUARD_ROOT")} });`],
    ["only a temp directory", `record({ dir: mkdtempSync(path.join(process.env.SFN_TEST_LEAK_GUARD_ROOT, "devfn-leaked-")) });`],
    // Only its argument names the root: whole on Linux, so it is stopped; ambiguous in macOS's ps listing, so it is only listed.
    ["a process that only names it", `record({ pid: ${orphanProcess('"/"', 'path.join(process.env.SFN_TEST_LEAK_GUARD_ROOT, "server.mjs")')} });`],
  ])("fails a run that leaves %s in its root and exits with success before its teardown, as Vitest does after its teardownTimeout", async (_, leak) => {
    const { dir, record } = project(`test("leaks into the run root", () => {
  ${leak}
});`, exitsFirst);
    const { code, output, recorded } = await runProject(dir, record);
    try {
      expect(code).not.toBe(0);
      expect(output).toContain("DevFn test leak guard: This interrupted test run left these behind.");
      expect(output).toContain(recorded.pid ? `process ${recorded.pid} ` : `temp entry ${recorded.dir}`);
      const listedOnly = leak.includes("server.mjs") && process.platform === "darwin";
      if (recorded.pid) expect(listedOnly ? alive(recorded.pid) : await gone(recorded.pid)).toBe(true);
      expect(existsSync(recorded.root)).toBe(false);
    } finally {
      if (recorded.pid) try { process.kill(recorded.pid, "SIGKILL"); } catch { /* already gone */ }
    }
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
  ])("stops what a leftover process starts in a group of its own as it is stopped, and lists, but never signals, what it starts in its stopped group, across every round, left in %s", async (_, where) => {
    const { dir, record } = project("");
    const leader = path.join(dir, "leader.cjs");
    const stopped = path.join(dir, "stopped.json");
    // Not the scope's, until it starts a process that is, a second after the first stop round
    // has killed `ownGroup`, so that a second round stops it.
    const later = `const { live } = require(${JSON.stringify(liveness)});
const [, ownGroup, where, file] = process.argv;
setTimeout(() => process.exit(1), 30_000);
const wait = setInterval(() => {
  if (live(Number(ownGroup))) return;
  clearInterval(wait);
  setTimeout(() => {
    const late = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", cwd: Buffer.from(where, "hex").toString(), env: { PATH: process.env.PATH } });
    require("node:fs").writeFileSync(file, String(late.pid));
    process.exit(0);
  }, 1_000);
}, 50);`;
    writeFileSync(leader, `const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {
  const keep = [process.execPath, ["-e", "setInterval(() => {}, 1000)"]];
  const env = { PATH: process.env.PATH };
  const sameGroup = spawn(...keep, { stdio: "ignore", cwd: "/", env });
  const ownGroup = spawn(...keep, { detached: true, stdio: "ignore", env });
  const watcher = spawn(process.execPath, ["-e", ${JSON.stringify(later)}, String(ownGroup.pid), Buffer.from(process.cwd()).toString("hex"), process.argv[2] + ".late"], { detached: true, stdio: "ignore", cwd: "/", env });
  require("node:fs").writeFileSync(process.argv[2], JSON.stringify({ sameGroup: sameGroup.pid, ownGroup: ownGroup.pid, watcher: watcher.pid }));
  process.exit(0);
});
setInterval(() => {}, 1000);
`);
    writeFileSync(path.join(dir, "fixture.test.mjs"), `${readFileSync(path.join(dir, "fixture.test.mjs"), "utf8")}
test("leaves a process that starts more as it stops", async () => {
  const where = ${where};
  const start = 'const child = require("node:child_process").spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: "ignore", env: { PATH: process.env.PATH } }); child.unref(); process.stdout.write(String(child.pid));';
  const pid = Number(require("node:child_process").spawnSync(process.execPath, ["-e", start, ${JSON.stringify(leader)}, ${JSON.stringify(stopped)}], { cwd: where, encoding: "utf8", env: { PATH: process.env.PATH } }).stdout);
  // A process the scope only reports keeps it waiting after each stop round, while the second one starts.
  record({ pid, named: ${orphanProcess('"/"', 'where + "/missing/../server.mjs"')} });
  // Long enough for the leader to install its SIGTERM handler.
  await sleep(500);
});`);
    // Whatever was started, read on its own: the run, or reading one of these, may fail.
    const read = (file: string) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } };
    try {
      const { code, output, recorded } = await runProject(dir, record);
      const { sameGroup, ownGroup } = read(stopped);
      const late = read(`${stopped}.late`);
      expect(code).not.toBe(0);
      for (const pid of [recorded.pid, late, sameGroup]) expect(output, output).toContain(`process ${pid} `);
      for (const pid of [recorded.pid, ownGroup, late]) expect(await gone(pid)).toBe(true);
      // Started in the leader's group after the guard last read that group, it is linked to the
      // leader by nothing the guard saw: it is listed from the first round on, and never signalled.
      expect(output).toMatch(new RegExp(`Not stopped: (?:\\d+, )*${sameGroup}\\b`));
      expect(alive(sameGroup)).toBe(true);
      expect(existsSync(recorded.root)).toBe(false);
    } finally {
      const started = read(stopped) ?? {};
      for (const pid of [read(record)?.pid, read(record)?.named, started.sameGroup, started.ownGroup, started.watcher, read(`${stopped}.late`)]) if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* stopped */ }
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
  expect(live(pid)).toBe(false);
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
    // The test file's own folder, which the guard made, is listed by its contents.
    expect(output).toContain(`temp entry ${recorded.dir}\n`);
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

  // A leader that, on SIGTERM, starts a process in its group and exits. That process, which runs
  // from "/" and so is found only through the leader's group, interrupts the run 300 ms later.
  const interruptingLeader = `const [dir, main] = process.argv.slice(1);
process.on("SIGTERM", () => {
  const script = "setTimeout(() => process.kill(" + main + ", 'SIGTERM'), 300); setInterval(() => {}, 1000)";
  const member = require("node:child_process").spawn(process.execPath, ["-e", script], { stdio: "ignore", cwd: "/", env: { PATH: process.env.PATH } });
  require("node:fs").writeFileSync(require("node:path").join(dir, "member.pid"), String(member.pid));
  process.exit(0);
});
setInterval(() => {}, 1000);`;

  // A leader whose group holds a process found only through it, which runs from "/" and outlives
  // SIGTERM. The leader exits on SIGTERM; 300 ms after SIGTERM, that process interrupts the run.
  const leaderOfInterrupter = `const [dir, main] = process.argv.slice(1);
const script = "process.on('SIGTERM', () => setTimeout(() => process.kill(" + main + ", 'SIGTERM'), 300)); setInterval(() => {}, 1000)";
const member = require("node:child_process").spawn(process.execPath, ["-e", script], { stdio: "ignore", cwd: "/", env: { PATH: process.env.PATH } });
process.on("SIGTERM", () => process.exit(0));
setTimeout(() => require("node:fs").writeFileSync(require("node:path").join(dir, "member.pid"), String(member.pid)), 300);
setInterval(() => {}, 1000);`;

  it("stops, through its group, a process its stop saw in a leader's group when the run is interrupted after the leader exits", async () => {
    const { dir, record } = project(`test("leaves a leader whose group holds a process found only through it", async () => {
  const pid = ${orphan("process.env.SFN_TEST_LEAK_GUARD_ROOT", ['"-e"', JSON.stringify(leaderOfInterrupter), "process.cwd()", "process.env.SFN_TEST_LEAK_GUARD_MAIN_PID"])};
  while (!existsSync("member.pid")) await sleep(20);
  record({ pid, child: Number(readFileSync("member.pid", "utf8")) });
}, 10_000);`);
    fixtureFiles.push(path.join(dir, "member.pid"));
    let member: number | undefined;
    try {
      const { code, output, recorded } = await runProject(dir, record);
      member = recorded.child;
      expect(code, output).not.toBe(0);
      expect(output).toContain("DevFn test leak guard: This interrupted test run left these behind.");
      expect(await gone(member!)).toBe(true);
      expect(alive(recorded.pid!)).toBe(false);
    } finally {
      if (member) try { process.kill(member, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("names a process its stop held in an exited leader's group when the run is interrupted before its teardown ends", async () => {
    // The leader's stop holds the process in its group, never signalled. The teardown then waits for
    // a process it can only report to exit, and the interruption lands in that wait.
    const { dir, record } = project(`test("leaves a leader and a process the guard can only report", () => {
  const pid = ${orphan("process.env.SFN_TEST_LEAK_GUARD_ROOT", ['"-e"', JSON.stringify(interruptingLeader), "process.cwd()", "process.env.SFN_TEST_LEAK_GUARD_MAIN_PID"])};
  record({ pid, named: ${orphanProcess('"/"', 'process.env.SFN_TEST_LEAK_GUARD_ROOT + "/missing/../server.mjs"')} });
});`);
    fixtureFiles.push(path.join(dir, "member.pid"), record);
    let named: number | undefined;
    let member: number | undefined;
    try {
      const { code, output, recorded } = await runProject(dir, record);
      named = recorded.named;
      member = Number(readFileSync(path.join(dir, "member.pid"), "utf8"));
      expect(code, output).not.toBe(0);
      expect(output).toContain("DevFn test leak guard: This interrupted test run left these behind.");
      expect(output).toContain(`process ${member} `);
      expect(output).toMatch(new RegExp(`Not stopped: (?:\\d+, )*${member}\\b`));
      expect(alive(recorded.pid!)).toBe(false);
    } finally {
      for (const pid of [named, member]) if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
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
  async function pausedLockCleanup(lock: string, during: (paused: { pid: number; marker: string }) => Promise<void>, env: Record<string, string> = {}) {
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

  // A process that has exited, for markers whose taker would otherwise count as dead.
  const exitedPid = spawnSync(process.execPath, ["-e", ""]).pid;
  it.each([
    ["a live waiter holds", { token: "waiter", pid: process.pid, createdAt: new Date().toISOString() }],
    // withFileLock cannot tell these takers dead either, so it never passes them.
    ["a marker without a token holds", { token: "", pid: exitedPid, createdAt: new Date().toISOString() }],
    ["a marker without a creation time holds", { token: "waiter", pid: exitedPid }],
    ["a marker with an ill-formed birth signature holds", { token: "waiter", pid: exitedPid, birthSignature: 1, createdAt: new Date().toISOString() }],
  ])("leaves in place, and lists, a dead holder's lock whose takeover marker %s", async (_, taker) => {
    const lock = machineLock(`devfn-leak-guard-lock-${randomUUID()}`);
    const marker = (record: string) => `owner.takeover.${createHash("sha256").update(record).digest("hex").slice(0, 32)}.0`;
    const { dir, record } = project(`test("holds the lock, which a live waiter is taking over, and hangs", async () => {
  ${takeLock(path.basename(lock))}
  const owner = readFileSync(path.join(lock, "owner.json"), "utf8");
  const marker = "owner.takeover." + require("node:crypto").createHash("sha256").update(owner).digest("hex").slice(0, 32) + ".0";
  writeFileSync(path.join(lock, marker), process.env.TAKER_RECORD);
  record({ pid: process.pid, dir: lock });
  await new Promise(() => {});
}, 60_000);`);
    try {
      const { code, output, recorded } = await runProject(dir, record, "signal", { env: { TAKER_RECORD: JSON.stringify(taker) } });
      expect(code).not.toBe(0);
      expect(alive(recorded.pid!)).toBe(false);
      expect(output).toContain(`${lock}, a machine-wide lock held by process ${recorded.pid}, which ended without releasing it; it was left in place`);
      expect(ownerRecord(lock)).toMatchObject({ token: "fixture", pid: recorded.pid });
      // Only the holder's record and the taker's marker: the guard took nothing and left nothing.
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

  it.each([["free"], ["reused by a live process"]])("lets withFileLock recover a dead holder's lock past the marker of a guard that died holding it, its process ID %s", async (reuse) => {
    const lock = machineLock(`devfn-leak-guard-lock-${randomUUID()}`);
    // The killed run leaves its temp root and Vitest's own folder behind, here.
    const parent = tempDir("devfn-leak-guard-parent-");
    try {
      let guardMarker = "";
      await pausedLockCleanup(lock, async ({ pid, marker }) => {
        guardMarker = marker;
        // The guard's marker identifies it as withFileLock's own records do.
        expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({ pid, birthSignature: await processBirthSignature(pid) });
        process.kill(pid, "SIGKILL");
      }, { TMPDIR: parent, TMP: parent, TEMP: parent });
      // This live process stands in for one that reused the dead guard's process ID.
      if (reuse !== "free") writeFileSync(guardMarker, JSON.stringify({ ...JSON.parse(readFileSync(guardMarker, "utf8")), pid: process.pid }));
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

  it.each([
    ["at its teardown", undefined],
    ["when it exits with success before its teardown", "exit"],
    ["when it is interrupted while its teardown waits for leftovers", "signal"],
  ] as const)("fails the run, without signalling them, on worktree orphans that run from the worktree or name only the worktree followed by another argument, %s", async (_, end) => {
    const { dir, record } = project(`test("leaves orphans in the worktree", () => {
  record({ pid: ${orphanProcess('path.join(process.cwd(), "package")')}, named: ${orphanProcess('"/"', "process.cwd()", '"--flag"')} });
});`, end === "exit" ? exitsFirst : {});
    mkdirSync(path.join(dir, ".git"));
    mkdirSync(path.join(dir, "package"));
    let recorded: { root: string; pid?: number; named?: number } | undefined;
    try {
      const result = await runProject(dir, record, end === "signal" ? "signal" : undefined, { duringTeardown: end === "signal" });
      recorded = result.recorded;
      expect(result.code, result.output).not.toBe(0);
      if (end) expect(result.output).toContain("DevFn test leak guard: This interrupted test run left these behind.");
      expect(result.output).toContain(`run from or name a path in the worktree ${realpathSync(dir)}, and were orphaned.`);
      for (const pid of [recorded.pid, recorded.named]) expect(result.output).toContain(`process ${pid} `);
      for (const pid of [recorded.pid, recorded.named]) expect(alive(pid!)).toBe(true);
    } finally {
      for (const pid of [recorded?.pid, recorded?.named]) if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("fails the run, without signalling it, on a worktree orphan named only by a path in a worktree folder whose name starts with '.. '", async () => {
    // A macOS listing shows "<worktree>/.. sibling/server.mjs", whose value may stop at "<worktree>/..", outside the worktree.
    const { dir, record } = project(`test("leaves an orphan naming a path in the worktree", () => {
  record({ named: ${orphanProcess('"/"', 'process.cwd() + "/.. sibling/server.mjs"')} });
});`);
    mkdirSync(path.join(dir, ".git"));
    mkdirSync(path.join(dir, ".. sibling"));
    let named: number | undefined;
    try {
      const { code, output, recorded } = await runProject(dir, record);
      named = recorded.named;
      expect(code, output).not.toBe(0);
      expect(output).toContain(`run from or name a path in the worktree ${realpathSync(dir)}, and were orphaned.`);
      expect(output).toContain(`process ${named} `);
      expect(alive(named!)).toBe(true);
    } finally {
      if (named) try { process.kill(named, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it.runIf(process.platform === "darwin")("lists a process it can only report that appears while the run's teardown waits for a worktree orphan", async () => {
    const { dir, record } = project(`test("leaves a worktree orphan and a starter that later names the run's root", () => {
  const hex = (value) => Buffer.from(value).toString("hex");
  record({ pid: ${orphanProcess('path.join(process.cwd(), "package")')} });
  ${orphan('"/"', ['path.join(process.cwd(), "late.cjs")', 'hex(process.env.SFN_TEST_LEAK_GUARD_ROOT + " sibling/x")', 'hex(path.join(process.cwd(), "late.pid"))'])};
});`);
    // Hex-encoded, so the starter itself names neither the root nor a path of the late process.
    writeFileSync(path.join(dir, "late.cjs"), `const [named, pidFile] = process.argv.slice(2).map((value) => Buffer.from(value, "hex").toString());
setTimeout(() => {
  const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", named], { detached: true, stdio: "ignore", cwd: "/", env: { PATH: process.env.PATH } });
  child.unref();
  require("node:fs").writeFileSync(pidFile, String(child.pid));
}, 2000);
`);
    mkdirSync(path.join(dir, ".git"));
    mkdirSync(path.join(dir, "package"));
    const latePid = () => existsSync(path.join(dir, "late.pid")) ? Number(readFileSync(path.join(dir, "late.pid"), "utf8")) : undefined;
    let orphaned: number | undefined;
    try {
      const { code, output, recorded } = await runProject(dir, record);
      orphaned = recorded.pid;
      expect(code, output).not.toBe(0);
      expect(output).toContain(`process ${orphaned} `);
      expect(output.slice(output.indexOf("These processes name one of the run's temp folders only where"))).toContain(`process ${latePid()} `);
      for (const pid of [orphaned, latePid()]) expect(alive(pid!)).toBe(true);
    } finally {
      await sleep(2_500);
      for (const pid of [orphaned, latePid()]) if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("stops, and lists, a process that appears in the run's root while the run's teardown waits once it has stopped the others", async () => {
    // A worktree orphan, which the guard never signals, starts a process in the run's root once
    // the teardown has stopped the run's own leftover. Hex-encoded, so the orphan names neither.
    const { dir, record } = project(`test("leaves a process in the root and a worktree orphan that waits for it to stop", () => {
  const hex = (value) => Buffer.from(value).toString("hex");
  const pid = ${orphanProcess("process.env.SFN_TEST_LEAK_GUARD_ROOT")};
  record({ pid, nested: ${orphan('"/"', ['path.join(process.cwd(), "starter.cjs")', "String(pid)", "hex(process.env.SFN_TEST_LEAK_GUARD_ROOT)", 'hex(path.join(process.cwd(), "child.pid"))'])} });
});`);
    writeFileSync(path.join(dir, "starter.cjs"), `const [pid, root, pidFile] = [process.argv[2], ...process.argv.slice(3).map((value) => Buffer.from(value, "hex").toString())];
const { live } = require(${JSON.stringify(liveness)});
// Once the guard has stopped that process, which may stay a zombie, and finished listing for what stopping it started.
const wait = setInterval(() => {
  if (live(Number(pid))) return;
  clearInterval(wait);
  setTimeout(() => {
    const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", cwd: root, env: { PATH: process.env.PATH } });
    child.unref();
    require("node:fs").writeFileSync(pidFile, String(child.pid));
  }, 1_000);
  setInterval(() => {}, 1000);
}, 50);
`);
    mkdirSync(path.join(dir, ".git"));
    const childPid = () => existsSync(path.join(dir, "child.pid")) ? Number(readFileSync(path.join(dir, "child.pid"), "utf8")) : undefined;
    let starter: number | undefined;
    try {
      const { code, output, recorded } = await runProject(dir, record);
      starter = recorded.nested;
      expect(code, output).not.toBe(0);
      expect(childPid()).toBeDefined();
      for (const pid of [recorded.pid, childPid()]) expect(output).toContain(`process ${pid} `);
      for (const pid of [recorded.pid, childPid()]) expect(await gone(pid!)).toBe(true);
      expect(alive(starter!)).toBe(true);
    } finally {
      for (const pid of [starter, childPid()]) if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  // Makes this process's process listings fail once `allowed` of them have succeeded, from outside
  // the guard: it replaces the Node functions the guard lists with (ps on macOS, /proc on Linux).
  // As a global setup, it does so in the run's main process before the guard's teardown runs.
  // From then on, a process whose ID a test wrote to replaced.pid shows a start one second (Linux:
  // one clock tick) later when read on its own, as a process that reused the ID would; with
  // UNREADABLE_ONCE, its first such read fails instead and later ones are true. With
// RESTARTED_ALWAYS ("later" or "unreadable"), listings never fail and every such read of it shows
// a later start or fails, while listings still read its real start.
  // SLOW_ENVIRONMENT_LISTING_MS delays the first listing's second macOS ps, as a loaded system may.
  const failListing = `const childProcess = require("node:child_process");
const fs = require("node:fs");
export function failListingsAfter(allowed) {
  let listings = 0;
  const fails = () => (listings += 1) > allowed;
  const failure = () => Object.assign(new Error("process listing failed (test)"), { code: "EIO" });
  const { spawnSync } = childProcess;
  const { readdirSync, readFileSync: read } = fs;
  const always = process.env.RESTARTED_ALWAYS;
  const replaced = () => (always || listings > allowed) && fs.existsSync("replaced.pid") ? read("replaced.pid", "utf8").trim() : undefined;
  let slowed = !process.env.SLOW_ENVIRONMENT_LISTING_MS;
  let unreadable = Boolean(process.env.UNREADABLE_ONCE);
  const later = (text) => text.replace(/:(\\d\\d)(?!:)/, (_, s) => ":" + String(s === "59" ? 58 : Number(s) + 1).padStart(2, "0"));
  childProcess.spawnSync = (command, args, ...rest) => {
    if (command === "ps" && args?.includes("-E") && !slowed) {
      slowed = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.SLOW_ENVIRONMENT_LISTING_MS));
    }
    // A macOS listing runs ps -A -ww once without -E and once with it; it counts once.
    if (command === "ps" && args?.includes("-ww") && !args.includes("-E") && fails()) return { error: failure() };
    // The guard reads several processes' starts with one ps -p; only this one's line changes.
    if (command === "ps" && args?.includes("-p") && replaced() && String(args.at(-1)).split(",").includes(replaced())) {
      if (unreadable || always === "unreadable") { unreadable = false; return { error: failure() }; }
      if (!process.env.UNREADABLE_ONCE) {
        const result = spawnSync(command, args, ...rest);
        return { ...result, stdout: result.stdout.split("\\n").map((line) => line.trim().startsWith(replaced() + " ") ? later(line) : line).join("\\n") };
      }
    }
    return spawnSync(command, args, ...rest);
  };
  fs.readdirSync = (target, ...rest) => { if (target === "/proc" && fails()) throw failure(); return readdirSync(target, ...rest); };
  fs.readFileSync = (target, ...rest) => {
    // Linux lists processes with the same file; a listing still reads the real start.
    if (always && target === "/proc/" + replaced() + "/stat" && new Error().stack.includes("listLinux")) return read(target, ...rest);
    if (target === "/proc/" + replaced() + "/stat" && (unreadable || always === "unreadable")) { unreadable = false; throw failure(); }
    const text = read(target, ...rest);
    if (target !== "/proc/" + replaced() + "/stat" || process.env.UNREADABLE_ONCE) return text;
    const at = text.lastIndexOf(")") + 2;
    const fields = text.slice(at).split(" ");
    fields[19] = String(Number(fields[19]) + 1);
    return text.slice(0, at) + fields.join(" ");
  };
  require("node:module").syncBuiltinESMExports();
}
export default () => { failListingsAfter(process.env.RESTARTED_ALWAYS ? Infinity : 1); };`;

  it("fails a test file, listing what it found, stopping what it owns and never signalling the rest, when listing processes fails after a listing found them", async () => {
    // One process the file owns, as the worker's child, and one it can only report: an orphan
    // naming a path under the file's folder through a directory that does not exist.
    const { dir, record } = project(`import { failListingsAfter } from "./fail-listing.mjs";
test("leaves processes, and then listing them fails", () => {
  record({ pid: ${leakProcess("tmpdir()")}, named: ${orphanProcess('"/"', 'tmpdir() + "/missing/../server.mjs"')} });
  failListingsAfter(1);
});`, { files: { "fail-listing.mjs": failListing } });
    let named: number | undefined;
    try {
      const { code, output, recorded } = await runProject(dir, record);
      named = recorded.named;
      expect(code, output).not.toBe(0);
      const fileReport = output.slice(output.indexOf(`DevFn test leak guard: ${path.join(dir, "fixture.test.mjs")} left these behind.`));
      expect(fileReport, output).toContain("Listing processes failed after an earlier listing had succeeded");
      for (const pid of [recorded.pid, named]) expect(fileReport).toContain(`process ${pid} `);
      expect(await gone(recorded.pid!)).toBe(true);
      expect(alive(named!)).toBe(true);
    } finally {
      if (named) try { process.kill(named, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it.each([
    ["at its teardown", false],
    ["when it exits with success before its teardown", true],
  ])("fails a run, listing what it found, stopping what it owns and never signalling the rest, when listing processes fails after a listing found them, %s", async (_, exits) => {
    // One process the run owns, running from its root, and one it can only report.
    const { dir, record } = project(`test("leaves processes in the run's root", () => {
  record({ pid: ${orphanProcess("process.env.SFN_TEST_LEAK_GUARD_ROOT")}, named: ${orphanProcess('"/"', 'process.env.SFN_TEST_LEAK_GUARD_ROOT + "/missing/../server.mjs"')} });
});`, { files: { "fail-listing.mjs": failListing, ...(exits ? exitsFirst.files : {}) }, options: `, globalSetup: [${JSON.stringify(guard)}, "./fail-listing.mjs"${exits ? ', "./exit.mjs"' : ""}]` });
    let named: number | undefined;
    try {
      const { code, output, recorded } = await runProject(dir, record);
      named = recorded.named;
      expect(code, output).not.toBe(0);
      expect(output).toContain(exits ? "DevFn test leak guard: This interrupted test run left these behind." : `DevFn test leak guard: This test run (temp root ${recorded.root}) left these behind.`);
      expect(output).toContain("Listing processes failed after an earlier listing had succeeded");
      for (const pid of [recorded.pid, named]) expect(output).toContain(`process ${pid} `);
      expect(await gone(recorded.pid!)).toBe(true);
      expect(alive(named!)).toBe(true);
      expect(existsSync(recorded.root)).toBe(false);
    } finally {
      if (named) try { process.kill(named, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it.each([
    ["a test file", true],
    ["a run", false],
  ])("fails %s whose every listing of processes fails, never taking that for nothing left running", async (_, inFile) => {
    const { dir, record } = project(inFile ? `import { failListingsAfter } from "./fail-listing.mjs";
test("cannot list processes", () => {
  failListingsAfter(0);
  record({});
});` : `test("passes", () => { record({}); });`, { files: { "fail-listing.mjs": failListing, "fail-all.mjs": `import { failListingsAfter } from "./fail-listing.mjs";\nexport default () => { failListingsAfter(0); };` }, options: inFile ? "" : `, globalSetup: [${JSON.stringify(guard)}, "./fail-all.mjs"]` });
    const { code, output } = await runProject(dir, record);
    expect(code, output).not.toBe(0);
    expect(output).toContain(inFile ? `DevFn test leak guard: ${path.join(dir, "fixture.test.mjs")} left these behind.` : "This test run (temp root");
    expect(output).toContain("Listing processes failed every time the guard tried");
  });

  it("never signals a process the run owned once listing processes fails and its process ID shows a process started a second later", async () => {
    const { dir, record } = project(`test("leaves a process in the run's root", () => {
  const pid = ${orphanProcess("process.env.SFN_TEST_LEAK_GUARD_ROOT")};
  writeFileSync("replaced.pid", String(pid));
  record({ pid });
});`, { files: { "fail-listing.mjs": failListing }, options: `, globalSetup: [${JSON.stringify(guard)}, "./fail-listing.mjs"]` });
    let pid: number | undefined;
    try {
      const { code, output, recorded } = await runProject(dir, record);
      pid = recorded.pid;
      expect(code, output).not.toBe(0);
      expect(output).toContain("Listing processes failed after an earlier listing had succeeded");
      // The process the ID now names is someone else's.
      expect(alive(pid!)).toBe(true);
    } finally {
      if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it.each([
    ["shows a later start", "later", false],
    ["cannot be read", "unreadable", false],
    ["shows a later start, when it exits with success before its teardown", "later", true],
    ["cannot be read, when it exits with success before its teardown", "unreadable", true],
  ])("fails a run, listing it but never signalling it, on a process it owns whose start read on its own %s, though every listing succeeds", async (_, restarted, exits) => {
    const { dir, record } = project(`test("leaves a process in the run's root", () => {
  const pid = ${orphanProcess("process.env.SFN_TEST_LEAK_GUARD_ROOT")};
  writeFileSync("replaced.pid", String(pid));
  record({ pid });
});`, { files: { "fail-listing.mjs": failListing, ...(exits ? exitsFirst.files : {}) }, options: `, globalSetup: [${JSON.stringify(guard)}, "./fail-listing.mjs"${exits ? ', "./exit.mjs"' : ""}]` });
    let pid: number | undefined;
    try {
      const { code, output, recorded } = await runProject(dir, record, undefined, { env: { RESTARTED_ALWAYS: restarted } });
      pid = recorded.pid;
      expect(code, output).not.toBe(0);
      expect(output).toContain(`process ${pid} `);
      if (!exits || restarted === "unreadable") expect(output).toMatch(new RegExp(`Not stopped: (?:\\d+, )*${pid}\\b`));
      expect(output).not.toContain("Listing processes failed");
      // Signalled by neither the teardown's SIGTERM and SIGKILL nor the exit cleanup's SIGKILL.
      expect(alive(pid!)).toBe(true);
    } finally {
      if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it.each([
    ["a test file", true],
    ["a run", false],
  ])("stops a process %s owned once listing processes fails, although the first read of its start failed", async (_, inFile) => {
    const { dir, record } = project(inFile ? `import { failListingsAfter } from "./fail-listing.mjs";
test("leaves a process, and then listing it fails", () => {
  const pid = ${leakProcess("tmpdir()")};
  writeFileSync("replaced.pid", String(pid));
  record({ pid });
  failListingsAfter(1);
});` : `test("leaves a process in the run's root", () => {
  const pid = ${orphanProcess("process.env.SFN_TEST_LEAK_GUARD_ROOT")};
  writeFileSync("replaced.pid", String(pid));
  record({ pid });
});`, { files: { "fail-listing.mjs": failListing }, ...(inFile ? {} : { options: `, globalSetup: [${JSON.stringify(guard)}, "./fail-listing.mjs"]` }) });
    let pid: number | undefined;
    try {
      const { code, output, recorded } = await runProject(dir, record, undefined, { env: { UNREADABLE_ONCE: "1" } });
      pid = recorded.pid;
      expect(code, output).not.toBe(0);
      // That scope's own report lists it among what the guard stopped, not what it only reports.
      const from = output.indexOf(`DevFn test leak guard: ${inFile ? path.join(dir, "fixture.test.mjs") : `This test run (temp root ${recorded.root})`} left these behind.`);
      const scoped = output.slice(from, output.indexOf("Stop every process a test starts", from));
      expect(from, output).toBeGreaterThanOrEqual(0);
      expect(scoped, output).toContain("Listing processes failed after an earlier listing had succeeded");
      expect(scoped).toContain(`process ${pid} `);
      expect(scoped).not.toContain("so it has not stopped them");
      expect(await gone(pid!)).toBe(true);
    } finally {
      if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it.runIf(process.platform === "darwin")("stops a process the run owned once listing processes fails, although the listing that found it took seconds", async () => {
    const { dir, record } = project(`test("leaves a process in the run's root", () => {
  record({ pid: ${orphanProcess("process.env.SFN_TEST_LEAK_GUARD_ROOT")} });
});`, { files: { "fail-listing.mjs": failListing }, options: `, globalSetup: [${JSON.stringify(guard)}, "./fail-listing.mjs"]` });
    let pid: number | undefined;
    try {
      const { code, output, recorded } = await runProject(dir, record, undefined, { env: { SLOW_ENVIRONMENT_LISTING_MS: "4000" } });
      pid = recorded.pid;
      expect(code, output).not.toBe(0);
      expect(output).toContain("Listing processes failed after an earlier listing had succeeded");
      expect(output).toContain(`process ${pid} `);
      expect(await gone(pid!)).toBe(true);
    } finally {
      if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
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
    // Each names the sibling as a path and on its own, followed by more arguments.
    siblings: ${JSON.stringify(besides)}.map((suffix) => process.cwd() + suffix).map((sibling) => ${orphanProcess("sibling", 'path.join(sibling, "server.mjs")', "sibling", '"--flag"', '"x"')}),
    nested: ${orphanProcess("nested", 'path.join(nested, "server.mjs")')},
    pid: ${orphanProcess("own", 'path.join(own, "server.mjs")')},
    // Named only in its arguments, from outside the worktree, as a wrapper's script is.
    named: ${orphanProcess('"/"', 'path.join(own, "server.mjs")')},
  });
});`);
    mkdirSync(path.join(dir, ".git"));
    mkdirSync(path.join(dir, "package"));
    mkdirSync(path.join(dir, ".worktrees", "other", "package"), { recursive: true });
    writeFileSync(path.join(dir, ".worktrees", "other", ".git"), "gitdir: elsewhere\n");
    for (const suffix of besides) mkdirSync(`${dir}${suffix}`);
    let recorded: { root: string; pid?: number; named?: number; siblings?: number[]; nested?: number } | undefined;
    try {
      const result = await runProject(dir, record);
      recorded = result.recorded;
      expect(result.code).not.toBe(0);
      expect(result.output).toContain(`run from or name a path in the worktree ${realpathSync(dir)}, and were orphaned.`);
      for (const pid of [recorded!.pid, recorded!.named]) expect(result.output).toContain(`process ${pid} `);
      for (const pid of [...recorded!.siblings!, recorded!.nested]) expect(result.output).not.toContain(`process ${pid} `);
      for (const pid of [recorded!.pid, recorded!.named, ...recorded!.siblings!, recorded!.nested]) expect(alive(pid!)).toBe(true);
    } finally {
      for (const pid of [recorded?.pid, recorded?.named, ...(recorded?.siblings ?? []), recorded?.nested]) if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
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

// stopProcesses signals a listed process only once a read of that process alone, just before the
// signal, shows it still runs with the start the listing read.
describe.skipIf(!["linux", "darwin"].includes(process.platform))("stopProcesses", { timeout: 30_000 }, () => {
  const nodeRequire = createRequire(import.meta.url);
  const fs = nodeRequire("node:fs") as typeof import("node:fs");
  const childProcess = nodeRequire("node:child_process") as typeof import("node:child_process");
  const { syncBuiltinESMExports } = nodeRequire("node:module") as typeof import("node:module");
  // One second later (macOS ps -o lstart) or one clock tick later (Linux /proc/<pid>/stat field 22).
  const later = (text: string) => text.replace(/:(\d\d)(?!:)/, (_, s: string) => `:${String(s === "59" ? 58 : Number(s) + 1).padStart(2, "0")}`);
  const pids: number[] = [];
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
    for (const pid of pids.splice(0)) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  });

  /**
   * From the read after the first `after` on, up to the `until`-th, this process's reads of
   * `pid`'s own start (ps -p on macOS, /proc/<pid>/stat on Linux), the ones the guard makes before
   * signalling (one, and for a group leader before SIGTERM a second once its group is read), fail or show a later start, as when the ID has been reused. The self-test's own
   * liveness check is unaffected.
   */
  function alterStartReads(pid: number, mode: "unreadable" | "later", after = 0, until = Infinity) {
    let reads = 0;
    const { spawnSync } = childProcess;
    const { readFileSync } = fs;
    const failure = () => Object.assign(new Error("reading the start failed (test)"), { code: "EIO" });
    (childProcess as { spawnSync: unknown }).spawnSync = (command: string, args: string[], ...rest: unknown[]) => {
      const result = (spawnSync as (...all: unknown[]) => { stdout: string })(command, args, ...rest);
      if (command !== "ps" || !args?.includes("-p") || !String(args.at(-1)).split(",").includes(String(pid)) || (reads += 1) <= after || reads > until) return result;
      return mode === "unreadable" ? { error: failure() } : { ...result, stdout: result.stdout.split("\n").map((line) => (line.trim().startsWith(`${pid} `) ? later(line) : line)).join("\n") };
    };
    (fs as { readFileSync: unknown }).readFileSync = (target: unknown, ...rest: unknown[]) => {
      const text = (readFileSync as (...all: unknown[]) => string)(target, ...rest);
      // Reading a group's processes reads every process's stat file too; those reads are left alone.
      if (target !== `/proc/${pid}/stat` || new Error().stack?.includes("groupMembers") || (reads += 1) <= after || reads > until) return text;
      if (mode === "unreadable") throw failure();
      const at = text.lastIndexOf(")") + 2;
      const fields = text.slice(at).split(" ");
      fields[19] = String(Number(fields[19]) + 1);
      return text.slice(0, at) + fields.join(" ");
    };
    syncBuiltinESMExports();
    restore = () => {
      (childProcess as { spawnSync: unknown }).spawnSync = spawnSync;
      (fs as { readFileSync: unknown }).readFileSync = readFileSync;
      syncBuiltinESMExports();
    };
  }

  /** Starts a detached Node process running `script`, and returns it once it has written its first line, with the output it writes. */
  async function start(script: string) {
    const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["pipe", "pipe", "ignore"] });
    pids.push(child.pid!);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    while (!output.includes("\n")) await sleep(20);
    return { child, pid: child.pid!, output: () => output };
  }
  /**
   * Makes this process's reads of a group's processes fail: the first `times` listings of a whole
   * group (ps -A without etime= on macOS, the /proc listing on Linux), and on Linux, in every such
   * listing, the reads of `files` (`/proc/<pid>/<file>` to an error code), which it also lists.
   */
  function failGroupReads(times = Infinity, files: Record<string, string> = {}) {
    let listings = 0;
    const { spawnSync } = childProcess;
    const { readdirSync, readFileSync } = fs;
    const failure = (code = "EIO") => Object.assign(new Error("reading the group failed (test)"), { code });
    const inGroupRead = () => new Error().stack?.includes("groupMembers") === true;
    (childProcess as { spawnSync: unknown }).spawnSync = (command: string, args: string[], ...rest: unknown[]) =>
      command === "ps" && args?.includes("-A") && !args.includes("etime=") && (listings += 1) <= times ? { error: failure() } : (spawnSync as (...all: unknown[]) => unknown)(command, args, ...rest);
    (fs as { readdirSync: unknown }).readdirSync = (target: unknown, ...rest: unknown[]) => {
      if (target === "/proc" && inGroupRead() && (listings += 1) <= times) throw failure();
      const names = (readdirSync as (...all: unknown[]) => string[])(target, ...rest);
      return target === "/proc" && inGroupRead() ? [...new Set([...names, ...Object.keys(files).map((file) => file.split("/")[2])])] : names;
    };
    (fs as { readFileSync: unknown }).readFileSync = (target: unknown, ...rest: unknown[]) => {
      if (typeof target === "string" && files[target] && inGroupRead()) throw failure(files[target]);
      return (readFileSync as (...all: unknown[]) => unknown)(target, ...rest);
    };
    syncBuiltinESMExports();
    restore = () => {
      Object.assign(childProcess, { spawnSync });
      Object.assign(fs, { readdirSync, readFileSync });
      syncBuiltinESMExports();
    };
  }
  /** A detached leader with one process in its group, which has exited once this returns: the process in its group and the leader as listed. */
  async function exitedLeader() {
    const { child, pid: leader, output } = await start(`const { spawn } = require("node:child_process");
const member = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.stdout.write(member.pid + "\\n");
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();`);
    const member = Number(output().trim());
    pids.push(member);
    const entry = listed(leader);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin!.end();
    await exited;
    return { member, entry };
  }
  const listed = (pid: number) => {
    const entry = listProcesses(Date.now())?.find((candidate) => candidate.pid === pid);
    expect(entry?.started, `process ${pid} is listed with its start`).toBeDefined();
    return entry!;
  };
  const ignoresSigterm = `process.on("SIGTERM", () => process.stdout.write("SIGTERM\\n")); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`;

  it("never signals a process whose ID shows another start than the one listed, though listing succeeds", async () => {
    const { pid } = await start(ignoresSigterm);
    const entry = listed(pid);
    for (const started of [typeof entry.started === "number" ? entry.started + 1 : later(String(entry.started)), 1]) {
      // The process listed has exited, as far as the guard can tell, so nothing is left of it.
      expect(await stopProcesses([{ ...entry, started }])).toEqual([]);
      expect(alive(pid)).toBe(true);
    }
  });

  it("never signals, and returns as still running, a process whose start cannot be read", async () => {
    const { pid } = await start(ignoresSigterm);
    const entry = listed(pid);
    alterStartReads(pid, "unreadable");
    expect((await stopProcesses([entry])).map((left) => left.pid)).toEqual([pid]);
    expect(alive(pid)).toBe(true);
  });

  it("keeps returning a process it was given whose start cannot be read, though a listing no longer shows it", async () => {
    const { pid: leader } = await start(`process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`);
    const { pid } = await start(ignoresSigterm);
    // Listed as a process of another group, it would be signalled on its own.
    const entry = { ...listed(pid), pgid: leader };
    alterStartReads(pid, "unreadable");
    expect((await stopProcesses([entry], () => [])).map((left) => left.pid)).toEqual([pid]);
    expect(alive(pid)).toBe(true);
  });

  it.runIf(process.platform === "linux")("fails a listing when a process's file cannot be read for any reason but that it has exited or is another user's", async () => {
    const { pid } = await start(`process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`);
    const { readFileSync, readlinkSync } = fs;
    let failing: [string, string] | undefined;
    const fail = (target: unknown) => {
      if (failing?.[1] && target === `/proc/${pid}/${failing[0]}`) throw Object.assign(new Error("reading failed (test)"), { code: failing[1] });
    };
    (fs as { readFileSync: unknown }).readFileSync = (target: unknown, ...rest: unknown[]) => {
      fail(target);
      // An empty code: the read succeeds with no text.
      return failing?.[1] === "" && target === `/proc/${pid}/${failing[0]}` ? "" : (readFileSync as (...all: unknown[]) => unknown)(target, ...rest);
    };
    (fs as { readlinkSync: unknown }).readlinkSync = (target: unknown, ...rest: unknown[]) => { fail(target); return (readlinkSync as (...all: unknown[]) => unknown)(target, ...rest); };
    syncBuiltinESMExports();
    restore = () => {
      Object.assign(fs, { readFileSync, readlinkSync });
      syncBuiltinESMExports();
    };
    for (const file of ["stat", "cmdline", "environ", "cwd"]) {
      failing = [file, "EIO"];
      expect(listProcesses(Date.now()), `${file} EIO`).toBeUndefined();
    }
    // A stat read with no text in it is not well formed.
    failing = ["stat", ""];
    expect(listProcesses(Date.now())).toBeUndefined();
    // Another user's process: listed, without what could not be read.
    failing = ["environ", "EACCES"];
    expect(listProcesses(Date.now())?.find((entry) => entry.pid === pid)?.environment).toBe("");
    // A process that has exited is left out.
    failing = ["cmdline", "ENOENT"];
    expect(listProcesses(Date.now())?.some((entry) => entry.pid === pid)).toBe(false);
  });

  it("reads a start that could not be read again, and stops the process once a read shows it is the one listed", async () => {
    const { pid } = await start(ignoresSigterm);
    const entry = listed(pid);
    // The reads before SIGTERM and before the first SIGKILL fail; later ones succeed.
    alterStartReads(pid, "unreadable", 0, 2);
    expect(await stopProcesses([entry], () => (alive(pid) ? [entry] : []))).toEqual([]);
    expect(await gone(pid)).toBe(true);
  });

  it("returns the leader of a group it cannot read once that leader has exited, never taking the group for an empty one", async () => {
    const { member, entry } = await exitedLeader();
    failGroupReads();
    expect((await stopProcesses([entry])).map((left) => left.pid)).toEqual([entry.pid]);
    expect(alive(member)).toBe(true);
  });

  it("clears an exited leader's group it could not read once a later read shows nothing left in it", async () => {
    const { child, pid } = await start(`process.stdout.write("ready\\n"); process.stdin.on("end", () => process.exit(0)); process.stdin.resume();`);
    const entry = listed(pid);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin!.end();
    await exited;
    // The reads in the SIGTERM and SIGKILL rounds fail; the one before the guard reports succeeds.
    failGroupReads(2);
    expect(await stopProcesses([entry])).toEqual([]);
  });

  it.runIf(process.platform === "linux")("lists a process in an exited leader's group whose command line cannot be read, and skips one that has exited", async () => {
    const { member, entry } = await exitedLeader();
    failGroupReads(0, { [`/proc/${member}/cmdline`]: "EIO", "/proc/2147483646/stat": "ENOENT" });
    expect((await stopProcesses([entry], () => [])).map((left) => left.pid)).toEqual([member]);
    expect(alive(member)).toBe(true);
  });

  it.runIf(process.platform === "linux")("returns the leader of an exited leader's group in which a process's stat cannot be read, never taking the group for one without it", async () => {
    const { member, entry } = await exitedLeader();
    failGroupReads(0, { [`/proc/${member}/stat`]: "EIO" });
    expect((await stopProcesses([entry], () => [])).map((left) => left.pid)).toEqual([entry.pid]);
    expect(alive(member)).toBe(true);
  });

  it.runIf(process.platform === "linux")("keeps listing a process a partial read of an exited leader's group found, though a later complete read no longer shows it there", async () => {
    const { member, entry } = await exitedLeader();
    // The reads in the SIGTERM and SIGKILL rounds fail; the next finds the process but cannot read
    // another process's stat; every later one shows the process in another group, as after setsid.
    let reads = 0;
    const { readdirSync, readFileSync } = fs;
    const failure = () => Object.assign(new Error("reading the group failed (test)"), { code: "EIO" });
    (fs as { readdirSync: unknown }).readdirSync = (target: unknown, ...rest: unknown[]) => {
      const names = (readdirSync as (...all: unknown[]) => string[])(target, ...rest);
      if (target !== "/proc" || !new Error().stack?.includes("groupMembers")) return names;
      if ((reads += 1) <= 2) throw failure();
      return reads === 3 ? [...names, "2147483646"] : names;
    };
    (fs as { readFileSync: unknown }).readFileSync = (target: unknown, ...rest: unknown[]) => {
      if (target === "/proc/2147483646/stat") throw failure();
      const text = (readFileSync as (...all: unknown[]) => string)(target, ...rest);
      if (target !== `/proc/${member}/stat` || reads <= 3 || !new Error().stack?.includes("groupMembers")) return text;
      const at = text.lastIndexOf(")") + 2;
      const fields = text.slice(at).split(" ");
      fields[2] = String(member);
      return text.slice(0, at) + fields.join(" ");
    };
    syncBuiltinESMExports();
    restore = () => {
      Object.assign(fs, { readdirSync, readFileSync });
      syncBuiltinESMExports();
    };
    expect((await stopProcesses([entry], () => [])).map((left) => left.pid)).toEqual([member]);
    expect(alive(member)).toBe(true);
  });

  it("never signals a group whose leader shows another start once the processes in its group have been read", async () => {
    const { pid } = await start(`process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`);
    const entry = listed(pid);
    expect(entry.pgid).toBe(pid);
    alterStartReads(pid, "later", 1);
    expect(await stopProcesses([entry])).toEqual([]);
    expect(alive(pid)).toBe(true);
  });

  it("reads a process's start again after reading the group of a leader signalled before it", async () => {
    const { pid: leader } = await start(`process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`);
    const { pid } = await start(`process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`);
    // Listed as a process of another group, it is signalled on its own, after the leader.
    const entries = [listed(leader), { ...listed(pid), pgid: leader }];
    // Its start, read with the leader's before SIGTERM, shows a later start once the leader's group has been read.
    alterStartReads(pid, "later", 1);
    await stopProcesses(entries);
    expect(await gone(leader)).toBe(true);
    expect(alive(pid)).toBe(true);
  });

  it("sends SIGKILL after SIGTERM only while the process ID still shows the start listed", async () => {
    const { pid, output } = await start(ignoresSigterm);
    const entry = listed(pid);
    // The reads before SIGTERM (it leads its group) show the start listed; every later one shows a later start.
    alterStartReads(pid, "later", 2);
    expect(await stopProcesses([entry])).toEqual([]);
    for (const deadline = Date.now() + 2_000; !output().includes("SIGTERM") && Date.now() < deadline;) await sleep(20);
    expect(output()).toContain("SIGTERM");
    expect(alive(pid)).toBe(true);
  });

  it("kills the group of a leader still itself in a SIGKILL round at once, with what it started since SIGTERM, however soon after the leader exits", async () => {
    // The leader outlives SIGTERM, and starts a process in its group when it gets it.
    const { pid: leader, output } = await start(`process.on("SIGTERM", () => {
  const member = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  require("node:fs").writeSync(1, member.pid + "\\n");
});
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);`);
    const entry = listed(leader);
    // Were the guard to read the group again after the read before SIGTERM, the leader would exit just before it.
    let reads = 0;
    const { spawnSync } = childProcess;
    const { readdirSync } = fs;
    const exitFirst = () => {
      if ((reads += 1) !== 2) return;
      process.kill(leader, "SIGKILL");
      while (alive(leader)) { /* until it is a zombie */ }
    };
    (childProcess as { spawnSync: unknown }).spawnSync = (command: string, args: string[], ...rest: unknown[]) => {
      if (command === "ps" && args?.includes("-A") && !args.includes("etime=")) exitFirst();
      return (spawnSync as (...all: unknown[]) => unknown)(command, args, ...rest);
    };
    (fs as { readdirSync: unknown }).readdirSync = (target: unknown, ...rest: unknown[]) => {
      if (target === "/proc" && new Error().stack?.includes("groupMembers")) exitFirst();
      return (readdirSync as (...all: unknown[]) => unknown)(target, ...rest);
    };
    syncBuiltinESMExports();
    restore = () => {
      Object.assign(childProcess, { spawnSync });
      Object.assign(fs, { readdirSync });
      syncBuiltinESMExports();
    };
    expect(await stopProcesses([entry])).toEqual([]);
    const member = Number(output().trim().split("\n")[1]);
    pids.push(member);
    expect(await gone(member)).toBe(true);
  });

  it("stops the group of a leader that exits on SIGTERM while a process the guard saw in that group as the leader ran is still in it", async () => {
    // The leader starts two processes in its group that outlive SIGTERM, and exits on SIGTERM.
    const { pid: leader, output } = await start(`const { spawn } = require("node:child_process");
const keep = () => spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
const members = [keep(), keep()];
process.on("SIGTERM", () => process.exit(0));
setTimeout(() => process.stdout.write(members.map((member) => member.pid).join(" ") + "\\n"), 500);
setInterval(() => {}, 1000);`);
    const members = output().trim().split(" ").map(Number);
    pids.push(...members);
    const entry = listed(leader);
    expect(entry.pgid).toBe(leader);
    // Only the leader is listed: the members are reached through its group, after it has exited.
    expect(await stopProcesses([entry])).toEqual([]);
    for (const member of members) expect(await gone(member)).toBe(true);
  });

  it("never signals a process its leader starts in its group as it exits on SIGTERM, after the guard last read that group, and returns it", async () => {
    const { pid: leader, output } = await start(`const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {
  const member = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  require("node:fs").writeSync(1, member.pid + "\\n");
  process.exit(0);
});
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);`);
    const entry = listed(leader);
    const left = await stopProcesses([entry]);
    const member = Number(output().trim().split("\n")[1]);
    pids.push(member);
    expect(left.map((process) => process.pid)).toEqual([member]);
    expect(alive(member)).toBe(true);
  });

  it("never signals the group of a leader that exited before the guard saw it, and returns the processes in that group", async () => {
    // The leader starts two processes in its group, then exits once its input closes.
    const { child, pid: leader, output } = await start(`const { spawn } = require("node:child_process");
const keep = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
const members = [keep(), keep()];
process.stdout.write(members.map((member) => member.pid).join(" ") + "\\n");
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();`);
    const members = output().trim().split(" ").map(Number);
    pids.push(...members);
    const entry = listed(leader);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin!.end();
    await exited;
    // As far as the guard can tell, the group may by now be another one with the same ID.
    expect((await stopProcesses([entry])).map((left) => left.pid).sort()).toEqual([...members].sort());
    for (const member of members) expect(alive(member)).toBe(true);
  });

  /** Makes this process's signals to the group `pgid` fail with EPERM: every one, or only `only`. */
  function refuseGroupSignals(pgid: number, only?: string) {
    const { kill } = process;
    process.kill = ((target: number, signal?: string | number) => {
      if (target === -pgid && (!only || signal === only)) throw Object.assign(new Error("not permitted (test)"), { code: "EPERM" });
      return kill.call(process, target, signal);
    }) as typeof process.kill;
    restore = () => { process.kill = kill; };
  }
  // The leader starts a process in its group that outlives SIGTERM, and exits on SIGTERM.
  const leaderOfSurvivor = `const member = require("node:child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.on("SIGTERM", () => process.exit(0));
setTimeout(() => process.stdout.write(member.pid + "\\n"), 500);
setInterval(() => {}, 1000);`;

  it.each([
    ["with no listing", undefined],
    ["with a listing that does not show it", () => []],
  ])("keeps returning a process it saw in a group it signalled once the leader has exited, while the process survives that signal, %s", async (_, find) => {
    const { pid: leader, output } = await start(leaderOfSurvivor);
    const member = Number(output().trim());
    pids.push(member);
    const entry = listed(leader);
    refuseGroupSignals(leader, "SIGKILL");
    expect((await stopProcesses([entry], find)).map((left) => left.pid)).toEqual([member]);
    expect(alive(member)).toBe(true);
  });

  it.each([
    ["with no listing", undefined],
    ["with a listing that does not show them", () => []],
  ])("keeps returning a process it saw in the group of a leader still itself while both survive SIGKILL to that group, %s", async (_, find) => {
    const { pid: leader, output } = await start(leaderOfSurvivor);
    const member = Number(output().trim());
    pids.push(member);
    const entry = listed(leader);
    refuseGroupSignals(leader);
    expect((await stopProcesses([entry], find)).map((left) => left.pid).sort()).toEqual([leader, member].sort());
    expect(alive(member)).toBe(true);
  });

  /**
   * Changes the reads of `pid` that `reader` (groupMembers or processStates) makes: its
   * /proc/<pid>/stat text on Linux, its line of ps output on macOS.
   */
  function alterReads(pid: number, reader: "groupMembers" | "processStates", change: (text: string) => string) {
    const { spawnSync } = childProcess;
    const { readFileSync } = fs;
    const inReader = () => new Error().stack?.includes(reader) === true;
    (childProcess as { spawnSync: unknown }).spawnSync = (command: string, args: string[], ...rest: unknown[]) => {
      const result = (spawnSync as (...all: unknown[]) => { stdout: string })(command, args, ...rest);
      if (command !== "ps" || !inReader() || !result.stdout) return result;
      return { ...result, stdout: result.stdout.split("\n").map((line) => (line.trim().startsWith(`${pid} `) ? change(line) : line)).join("\n") };
    };
    (fs as { readFileSync: unknown }).readFileSync = (target: unknown, ...rest: unknown[]) => {
      const text = (readFileSync as (...all: unknown[]) => string)(target, ...rest);
      return target === `/proc/${pid}/stat` && inReader() ? change(text) : text;
    };
    syncBuiltinESMExports();
    restore = () => {
      Object.assign(childProcess, { spawnSync });
      Object.assign(fs, { readFileSync });
      syncBuiltinESMExports();
    };
  }
  const statField = (index: number, value: string) => (text: string) => {
    const at = text.lastIndexOf(")") + 2;
    const fields = text.slice(at).split(" ");
    fields[index] = value;
    return text.slice(0, at) + fields.join(" ");
  };
  // Reads that are not well formed: a Linux stat, or a macOS ps line.
  const malformed: [string, (text: string) => string][] = process.platform === "linux" ? [
    ["with no ')' after its name", (text) => text.replace(/\)(?=[^)]*$)/, "")],
    ["with too few fields", (text) => text.slice(0, text.lastIndexOf(")") + 2) + "S 1"],
    ["with a group that is not a number", statField(2, "x")],
    ["with a start that is not a number", statField(19, "x")],
  ] : [
    ["with no start", (line) => line.replace(/\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+/, "")],
    ["with nothing after its ID", (line) => line.replace(/^(\s*\d+).*$/, "$1")],
  ];

  it.each(malformed)("returns the leader of an exited leader's group whose read shows a process %s, never taking the group for one without it", async (_, change) => {
    const { member, entry } = await exitedLeader();
    alterReads(member, "groupMembers", change);
    expect((await stopProcesses([entry], () => [])).map((left) => left.pid)).toEqual([entry.pid]);
    expect(alive(member)).toBe(true);
  });

  it.each(malformed)("keeps returning a process held in an exited leader's group whose own read shows it %s, never taking it for another process", async (_, change) => {
    const { member, entry } = await exitedLeader();
    alterReads(member, "processStates", change);
    expect((await stopProcesses([entry], () => [])).map((left) => left.pid)).toEqual([member]);
    expect(alive(member)).toBe(true);
  });

  /**
   * Of an exited `leader`'s group, the first read is partial and the second fails. After them, a
   * read of the leader's own start shows another process's (`"other"`) or fails (`"unreadable"`),
   * and every read of the group shows `joins`, when given, in it too, as a new group with the same
   * ID would.
   */
  function rereadAfterFailures(leader: number, after: "other" | "unreadable" | "reused", joins?: number) {
    let reads = 0;
    // "reused": the leader's ID names another process only from the third read of its group on.
    const from = after === "reused" ? 3 : 2;
    const { spawnSync } = childProcess;
    const { readdirSync, readFileSync } = fs;
    const failure = () => Object.assign(new Error("reading failed (test)"), { code: "EIO" });
    const inGroupRead = () => new Error().stack?.includes("groupMembers") === true;
    const regroup = (line: string) => (joins && line.trim().startsWith(`${joins} `) ? line.replace(/^(\s*\d+\s+\d+\s+)\d+/, `$1${leader}`) : line);
    (childProcess as { spawnSync: unknown }).spawnSync = (command: string, args: string[], ...rest: unknown[]) => {
      const real = (spawnSync as (...all: unknown[]) => { stdout: string })(command, args, ...rest);
      if (command === "ps" && args?.includes("-A") && !args.includes("etime=")) {
        if ((reads += 1) === 2) return { error: failure() };
        return { ...real, stdout: reads === 1 ? `${real.stdout}not a process line\n` : real.stdout.split("\n").map(regroup).join("\n") };
      }
      const asked = command === "ps" && args?.includes("-p") ? String(args.at(-1)).split(",") : [];
      if (reads < from || !asked.includes(String(leader))) return real;
      if (after === "unreadable") return { error: failure() };
      // This process's line, under the leader's ID: the ID names a process with another start.
      const own = (spawnSync as (...all: unknown[]) => { stdout: string })(command, [...args.slice(0, -1), String(process.pid)], ...rest).stdout.replace(/^(\s*)\d+/, `$1${leader}`);
      return { ...real, status: 0, stdout: real.stdout + own };
    };
    (fs as { readdirSync: unknown }).readdirSync = (target: unknown, ...rest: unknown[]) => {
      const names = (readdirSync as (...all: unknown[]) => string[])(target, ...rest);
      if (target !== "/proc" || !inGroupRead()) return names;
      if ((reads += 1) === 2) throw failure();
      return reads === 1 ? [...names, "2147483646"] : names;
    };
    (fs as { readFileSync: unknown }).readFileSync = (target: unknown, ...rest: unknown[]) => {
      if (target === "/proc/2147483646/stat") throw failure();
      if (target === `/proc/${leader}/stat` && reads >= from && !inGroupRead()) {
        if (after === "unreadable") throw failure();
        return (readFileSync as (...all: unknown[]) => string)(`/proc/${process.pid}/stat`, ...rest).replace(/^\d+/, String(leader));
      }
      const text = (readFileSync as (...all: unknown[]) => string)(target, ...rest);
      return joins && reads >= 3 && target === `/proc/${joins}/stat` && inGroupRead() ? statField(2, String(leader))(text) : text;
    };
    syncBuiltinESMExports();
    restore = () => {
      Object.assign(childProcess, { spawnSync });
      Object.assign(fs, { readdirSync, readFileSync });
      syncBuiltinESMExports();
    };
  }

  it("reports none of a new group with an unresolved exited leader's ID once the leader's ID names another process, but keeps what an earlier read of its group found", async () => {
    const { pid: stranger } = await start(`process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`);
    const { member, entry } = await exitedLeader();
    rereadAfterFailures(entry.pid, "other", stranger);
    expect((await stopProcesses([entry], () => [])).map((left) => left.pid)).toEqual([member]);
    expect(alive(member)).toBe(true);
    expect(alive(stranger)).toBe(true);
  });

  it("takes no read of an unresolved exited leader's group after which the leader's ID names another process, though it had exited just before", async () => {
    const { pid: stranger } = await start(`process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`);
    const { member, entry } = await exitedLeader();
    rereadAfterFailures(entry.pid, "reused", stranger);
    expect((await stopProcesses([entry], () => [])).map((left) => left.pid)).toEqual([member]);
    expect(alive(stranger)).toBe(true);
  });

  it("keeps returning an unresolved exited leader whose own start cannot be read, without trusting a read of its group", async () => {
    const { member, entry } = await exitedLeader();
    rereadAfterFailures(entry.pid, "unreadable");
    expect((await stopProcesses([entry], () => [])).map((left) => left.pid).sort()).toEqual([member, entry.pid].sort());
    expect(alive(member)).toBe(true);
  });
});
