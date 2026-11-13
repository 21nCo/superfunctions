// Whether a process runs, for the leak guard's self-test (leak-guard.test.ts) and every script it
// generates. An unreaped zombie, which a container's PID 1 that does not reap orphans leaves
// behind, does not run, although kill(pid, 0) still succeeds for it. So this reads the process's
// state from /proc on Linux and from ps elsewhere, independently of the guard's own listing. It is
// the self-test's only liveness check; a self-test fails on a bare kill(pid, 0) anywhere else.
// It is also the self-test's only way to signal a fixture (stop): only the process that recorded
// start names. It reads through `system`, taken at load, so a test that replaces the Node functions
// the guard reads with changes none of this; a test of this file replaces `system`'s instead.
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");

const system = { readFileSync, spawnSync };
// Reads of a process made in a row before one that fails is taken for an answer.
const TRIES = 3;

/**
 * What runs as `pid`, read on its own: { started } for a process that runs (not a zombie), with
 * its start, the same for every read of that process and another for a later process given its
 * ID (to the second on macOS, as ps shows it); { gone } when no process runs as `pid`; undefined
 * when that cannot be read.
 */
function readOnce(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try { process.kill(pid, 0); } catch (error) { return error?.code === "ESRCH" ? { gone: true } : undefined; }
  if (process.platform === "linux") {
    let stat;
    try { stat = system.readFileSync(`/proc/${pid}/stat`, "utf8"); } catch (error) {
      return ["ENOENT", "ESRCH"].includes(error?.code) ? { gone: true } : undefined;
    }
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (!/^[A-Za-z]$/.test(fields[0] ?? "") || !/^\d+$/.test(fields[19] ?? "")) return undefined;
    return /^[ZXx]$/.test(fields[0]) ? { gone: true } : { started: `linux:${fields[19]}` };
  }
  // The system's own ps, by absolute path and with a fixed system PATH, never one the inherited PATH names.
  const result = system.spawnSync("/bin/ps", ["-o", "stat=", "-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { PATH: "/bin:/usr/bin", LC_ALL: "C", TZ: "UTC0" } });
  const line = result.stdout?.trim() ?? "";
  // ps lists the processes that run, and exits 1 with nothing when none of them does.
  if (result.status === 1 && !result.error && line === "") return { gone: true };
  const match = result.status === 0 ? /^(\S+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)$/.exec(line) : null;
  if (!match) return undefined;
  return match[1].startsWith("Z") ? { gone: true } : { started: `ps:${match[2].replaceAll(/\s+/g, " ")}` };
}

/** readOnce, made again up to TRIES times while it cannot be read. */
function identity(pid) {
  let current;
  for (let tries = 0; current === undefined && tries < TRIES; tries += 1) current = readOnce(pid);
  return current;
}

const live = (pid) => identity(pid)?.started !== undefined;

/** The start of the process that runs as `pid` (identity), or undefined when none does or it cannot be read. */
const started = (pid) => identity(pid)?.started;

/**
 * How a fixture names the process `pid` while it knows it runs, for stop: { pid, started }, with
 * started null when its start cannot be read (which stop never signals, and the self-test lists
 * as not shown gone), or { pid, gone } when no process runs as `pid` (nothing to stop).
 */
function fixture(pid) {
  const current = identity(pid);
  return current?.gone ? { pid, gone: true } : { pid, started: current?.started ?? null };
}

/**
 * Sends `fixture` ({ pid, started }, its start read while it ran) SIGKILL only when a read just
 * before shows its ID still running with that start. It reads the ID first, whatever the fixture
 * recorded. Returns "stopped" once it has signalled; "gone" when no process runs as the ID (a
 * zombie included), or the ID names a process started at another time than the one recorded
 * (never signalled); "unknown" when it cannot tell (the read failed, the signal did, or the ID
 * runs but no start was recorded to tell it is the fixture), and then it signals nothing.
 */
function stop(fixture) {
  const current = identity(fixture?.pid);
  if (current?.gone) return "gone";
  if (current === undefined || typeof fixture.started !== "string") return "unknown";
  if (current.started !== fixture.started) return "gone";
  try { process.kill(fixture.pid, "SIGKILL"); return "stopped"; } catch (error) { return error?.code === "ESRCH" ? "gone" : "unknown"; }
}

module.exports = { fixture, live, started, stop, system };
