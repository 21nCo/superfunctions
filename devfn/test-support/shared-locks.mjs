// Locks that test fixtures in different files, packages and runs take to share a fixed
// machine-wide resource, such as Caddy's admin port 127.0.0.1:2019. The leak guard points
// TMPDIR at a folder of each test file's own, so such a lock lives in the temp folder the run
// started with instead: every guarded run and file, and an unguarded one, then name the same
// lock. Node built-ins only, like leak-guard.mjs.

import os from "node:os";
import path from "node:path";

import { ORIGINAL_TEMP_VARIABLE } from "./leak-guard.mjs";

/** The path of the machine-wide test lock with the given name. */
export function machineLockPath(name) {
  return path.join(process.env[ORIGINAL_TEMP_VARIABLE] || os.tmpdir(), name);
}

/** The lock every fixture that needs Caddy's fixed admin port 127.0.0.1:2019 free holds. */
export function caddyAdminLockPath() {
  return machineLockPath("devfn-test-caddy-admin.lock");
}
