// Temp directories that a test file removes after each test, whether the test passes,
// fails or times out, together with any process still running from them. Node built-ins
// only, like leak-guard.mjs.

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { removeTree, stopProcessesUnder } from "./leak-guard.mjs";

/**
 * Registers teardown with the given hook (Vitest's `afterEach` or `afterAll`) and returns a
 * function that creates a temp directory with the given prefix. The hook stops every process
 * that runs from, or names, one of those directories (a DevFn wrapper with its detached process
 * group, a fixture server or tunnel), then removes the directories. Vitest runs the hook after a
 * test times out, while a `finally` in the test only runs once the stalled call settles.
 */
export function temporaryDirectories(hook) {
  let created = [];
  let since = Date.now();
  hook(async () => {
    const directories = created;
    created = [];
    if (directories.length === 0) return;
    const running = await stopProcessesUnder(directories, since);
    const failed = directories.filter((directory) => !removeTree(directory));
    since = Date.now();
    if (running.length > 0 || failed.length > 0) {
      throw new Error([
        ...running.map((entry) => `Process ${entry.pid} still runs from a test's temp directory after SIGKILL: ${entry.command}`),
        ...failed.map((directory) => `Could not remove the temp directory ${directory}.`),
      ].join("\n"));
    }
  }, 30_000);
  return (prefix) => {
    if (created.length === 0) since = Date.now();
    const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
    created.push(directory);
    return directory;
  };
}
