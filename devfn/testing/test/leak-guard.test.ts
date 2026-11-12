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

import { attributeProcesses, ORIGINAL_TEMP_VARIABLE, ownedProcesses, pathAliases, pathsNamedUnder } from "../../test-support/leak-guard.mjs";
import { temporaryDirectories } from "../../test-support/temp-directories.mjs";

const tempDir = temporaryDirectories(afterEach);
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
    ];
    // <run>/link/../x is <run>/deep/x through the link and <run>/x as written: under the run either way.
    const owned = [linux(9_000_711, `node\0file://${run}/sub/%2e%2e/x.mjs\0`), linux(9_000_712, `node\0${run}/link/../x.mjs\0`)];
    const ambiguous = [
      // A URL Node cannot decode, and a '..' the system cannot follow.
      linux(9_000_721, `node\0file://${run}%2Fx\0`), linux(9_000_722, `node\0${run}/missing/../x\0`),
      // <run>/.. alone is outside the run, but the value may be "<run>/.. sibling/server.mjs".
      macos(9_000_723, `node ${run}/.. sibling/server.mjs`),
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
  const failListing = `const childProcess = require("node:child_process");
const fs = require("node:fs");
export function failListingsAfter(allowed) {
  let listings = 0;
  const fails = () => (listings += 1) > allowed;
  const failure = () => Object.assign(new Error("process listing failed (test)"), { code: "EIO" });
  const { spawnSync } = childProcess;
  const { readdirSync } = fs;
  // A macOS listing runs ps -A -ww once without -E and once with it; it counts once.
  childProcess.spawnSync = (command, args, ...rest) => command === "ps" && args?.includes("-ww") && !args.includes("-E") && fails() ? { error: failure() } : spawnSync(command, args, ...rest);
  fs.readdirSync = (target, ...rest) => { if (target === "/proc" && fails()) throw failure(); return readdirSync(target, ...rest); };
  require("node:module").syncBuiltinESMExports();
}
export default () => { failListingsAfter(1); };`;

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
