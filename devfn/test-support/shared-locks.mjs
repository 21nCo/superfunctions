// Locks that test fixtures in different files, packages and runs take to share a fixed
// machine-wide resource, such as Caddy's admin port 127.0.0.1:2019. The leak guard points
// TMPDIR at a folder of each test file's own, so such a lock lives in the temp folder the run
// started with instead: every guarded run and file, and an unguarded one, then name the same
// lock. Node built-ins only, like leak-guard.mjs.
//
// Naming a lock records it in the guarded run's root. A lock lives outside that root, so when
// the process holding it is killed before releasing it (an interrupted run, or a worker stopped
// at the run's end), the run's cleanup then removes it, once that process is gone, and lists it.
// It never touches a lock another run's process holds or one whose holder is still running, and
// moves one away only under withFileLock's own takeover protocol, so no waiter recovering it
// meanwhile can lose it; one another process is taking over stays in place, and is listed.

import os from "node:os";
import path from "node:path";

import { ORIGINAL_TEMP_VARIABLE, recordMachineLock } from "./leak-guard.mjs";

/**
 * The path of the machine-wide test lock with the given name. Call it in the process that takes
 * the lock, before taking it.
 */
export function machineLockPath(name) {
  const lockPath = path.join(process.env[ORIGINAL_TEMP_VARIABLE] || os.tmpdir(), name);
  recordMachineLock(lockPath);
  return lockPath;
}

/** The lock every fixture that needs Caddy's fixed admin port 127.0.0.1:2019 free holds. */
export function caddyAdminLockPath() {
  return machineLockPath("devfn-test-caddy-admin.lock");
}
