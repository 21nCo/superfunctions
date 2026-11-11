import { closeSync, fstatSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareProcessLog } from "../src/supervisor.js";

// before runs ahead of each lstat or unlink the supervisor makes of a path, as
// an interleaved actor; it sees the operation and the call number for that path.
const { hook } = vi.hoisted(() => ({ hook: {} as { before?: (operation: "lstat" | "unlink", file: string, call: number) => Promise<void> | void } }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const calls = new Map<string, number>();
  const around = <A extends unknown[], R>(operation: "lstat" | "unlink", run: (file: string, ...rest: A) => Promise<R>) => async (file: string, ...rest: A): Promise<R> => {
    const call = (calls.get(String(file)) ?? 0) + 1;
    calls.set(String(file), call);
    await hook.before?.(operation, String(file), call);
    return await run(file, ...rest);
  };
  return { ...actual, lstat: around("lstat", actual.lstat as (file: string) => Promise<import("node:fs").Stats>), unlink: around("unlink", actual.unlink as (file: string) => Promise<void>) };
});

afterEach(() => { delete hook.before; });

async function linkedLog() {
  const root = await mkdtemp(path.join(tmpdir(), "devfn-log-race-"));
  const other = path.join(root, "other.log");
  const logPath = path.join(root, "app.log");
  await writeFile(other, "other runtime\n");
  await link(other, logPath);
  return { root, other, logPath };
}

describe("process log preparation", () => {
  it("never removes a log name that a racing preparation already replaced with a fresh log", async () => {
    const { root, other, logPath } = await linkedLog();
    let freshIno: number | undefined;
    // After the shared inode was opened and before the name is removed (the
    // second filesystem call on the name), another preparation puts a fresh log there.
    hook.before = (_operation, file, call) => {
      if (file !== logPath || call !== 2) return;
      rmSync(logPath);
      writeFileSync(logPath, "fresh\n", { mode: 0o600 });
      freshIno = statSync(logPath).ino;
    };
    try {
      const { logFd } = await prepareProcessLog(logPath, false);
      try {
        writeSync(logFd, "mine\n");
        expect(freshIno).toBeDefined();
        expect(fstatSync(logFd).ino).toBe(freshIno);
        expect((await stat(logPath)).ino).toBe(freshIno);
      } finally { closeSync(logFd); }
      expect(readFileSync(logPath, "utf8")).toBe("fresh\nmine\n");
      expect(await readFile(other, "utf8")).toBe("other runtime\n");
      expect((await stat(other)).nlink).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("prepares one log at a time, under any alias, so concurrent preparations share one reachable log and never touch the other name", async () => {
    for (const [reset, aliased] of [[false, "none"], [true, "none"], [false, "directory"], [false, "case"], [true, "case"]] as const) {
      const { root, other, logPath } = await linkedLog();
      // The second preparation may name the log through a linked directory,
      // or in other letter case where the filesystem ignores case.
      const alias = path.join(root, "alias");
      await symlink(root, alias);
      const upper = path.join(root, "APP.log");
      if (aliased === "case" && await stat(upper).then((found) => found.ino !== statSync(logPath).ino, () => true)) { await rm(root, { recursive: true, force: true }); continue; }
      const second = { none: logPath, directory: path.join(alias, path.basename(logPath)), case: upper }[aliased];
      // Each removal of the name lands later than the last, as a slow
      // filesystem would order them, after the next preparation has looked.
      let removals = 0;
      hook.before = async (operation, file) => {
        if (operation !== "unlink" || (file !== logPath && file !== second)) return;
        removals += 1;
        await new Promise((resolve) => setTimeout(resolve, 40 * removals));
      };
      try {
        const prepared = await Promise.all([prepareProcessLog(logPath, reset), prepareProcessLog(second, reset)]);
        try {
          const reachable = (await stat(logPath)).ino;
          for (const { logFd } of prepared) expect(fstatSync(logFd).ino).toBe(reachable);
          writeSync(prepared[0]!.logFd, "first\n");
          writeSync(prepared[1]!.logFd, "second\n");
        } finally { for (const { logFd } of prepared) closeSync(logFd); }
        expect(readFileSync(logPath, "utf8")).toBe("first\nsecond\n");
        expect(await readFile(other, "utf8")).toBe("other runtime\n");
        expect((await stat(other)).nlink).toBe(1);
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  });
});
