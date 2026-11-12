// Whether a process runs, for the leak guard's self-test (leak-guard.test.ts) and every script it
// generates. An unreaped zombie, which a container's PID 1 that does not reap orphans leaves
// behind, does not run, although kill(pid, 0) still succeeds for it. So this reads the process's
// state from /proc on Linux and from ps elsewhere, independently of the guard's own listing. It is
// the self-test's only liveness check; a self-test fails on a bare kill(pid, 0) anywhere else.
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");

function live(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return !/^[ZX]/.test(stat.slice(stat.lastIndexOf(")") + 2));
    } catch { return false; }
  }
  // The system's own ps, by absolute path and with a fixed system PATH, never one the inherited PATH names.
  const state = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", env: { PATH: "/bin:/usr/bin", LC_ALL: "C" } }).stdout.trim();
  return state !== "" && !state.startsWith("Z");
}

module.exports = { live };
