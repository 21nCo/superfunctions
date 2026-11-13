// Whether a process runs, for the leak guard's self-test (leak-guard.test.ts) and every script it
// generates. An unreaped zombie, which a container's PID 1 that does not reap orphans leaves
// behind, does not run, although kill(pid, 0) still succeeds for it. So this reads the process's
// state from /proc on Linux and from ps elsewhere, independently of the guard's own listing. It is
// the self-test's only liveness check; a self-test fails on a bare kill(pid, 0) anywhere else.
// It is also the self-test's only way to signal a fixture (stop): only the process that recorded
// start names. Its bindings are taken at load, so a test that replaces the Node functions the guard
// reads with changes none of this.
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");

/** The process's state and start, read on their own: undefined when no process has the ID or the read fails. */
function read(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return { state: fields[0], started: /^\d+$/.test(fields[19] ?? "") ? `linux:${fields[19]}` : undefined };
    } catch { return undefined; }
  }
  // The system's own ps, by absolute path and with a fixed system PATH, never one the inherited PATH names.
  const line = spawnSync("/bin/ps", ["-o", "stat=", "-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { PATH: "/bin:/usr/bin", LC_ALL: "C", TZ: "UTC0" } }).stdout?.trim() ?? "";
  const match = /^(\S+)\s+(\S.*)$/.exec(line);
  return match ? { state: match[1], started: `ps:${match[2].replaceAll(/\s+/g, " ")}` } : undefined;
}

/** The process that runs as `pid` (not a zombie), read on its own, or undefined. */
function running(pid) {
  try { process.kill(pid, 0); } catch { return undefined; }
  const current = read(pid);
  return current && !/^[ZX]/.test(current.state) ? current : undefined;
}

const live = (pid) => running(pid) !== undefined;

/**
 * The start of the process that runs as `pid`, the same for every read of that process and another
 * for a later process given its ID (to the second on macOS, as ps shows it); undefined when none
 * runs as `pid` or its start cannot be read.
 */
function started(pid) {
  return running(pid)?.started;
}

/**
 * Sends `fixture` ({ pid, started }, its start read while it ran) SIGKILL only when a read just
 * before shows its ID still running with that start, never for a fixture with no start recorded,
 * one whose start cannot be read now or one whose ID names another process. Returns whether it did.
 */
function stop(fixture) {
  if (typeof fixture?.started !== "string" || started(fixture.pid) !== fixture.started) return false;
  try { process.kill(fixture.pid, "SIGKILL"); return true; } catch { return false; }
}

module.exports = { live, started, stop };
