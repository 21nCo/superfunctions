import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { InstalledWriteError, writePrivateFile } from "../src/tunnel/state.js";

// Every file and directory sync, by path; a sync of a path ending in a key of fail fails with that error code, as does the open or close of a path ending in a key of failOpen or failClose.
const { syncs } = vi.hoisted(() => ({ syncs: { seen: [] as string[], fail: new Map<string, string>(), failOpen: new Map<string, string>(), failClose: new Map<string, string>() } }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const failure = (faults: Map<string, string>, target: string) => {
    const code = [...faults].find(([suffix]) => target.endsWith(suffix))?.[1];
    return code ? Object.assign(new Error(`failed: ${code}`), { code }) : undefined;
  };
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const target = String(args[0]);
    const openFailure = failure(syncs.failOpen, target);
    if (openFailure) throw openFailure;
    const handle = await actual.open(...args);
    const close = handle.close.bind(handle);
    handle.close = async () => { await close(); const closeFailure = failure(syncs.failClose, target); if (closeFailure) throw closeFailure; };
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      syncs.seen.push(target);
      const code = [...syncs.fail].find(([suffix]) => target.endsWith(suffix))?.[1];
      if (code) throw Object.assign(new Error(`sync failed: ${code}`), { code });
      await sync();
    };
    return handle;
  } };
});

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "devfn-tunnel-state-"));
  file = path.join(dir, "state.json");
  syncs.seen.length = 0;
  syncs.fail.clear();
  syncs.failOpen.clear();
  syncs.failClose.clear();
});

afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it("syncs a journal file before it replaces the previous one, and fails the write when that sync fails", async () => {
  await writePrivateFile(file, "one");
  expect(syncs.seen).toEqual([expect.stringMatching(/\.tmp$/), dir]);
  syncs.fail.set(".tmp", "EIO");
  await expect(writePrivateFile(file, "two")).rejects.toMatchObject({ code: "EIO" });
  expect(await readFile(file, "utf8")).toBe("one");
  expect(await readdir(dir)).toEqual(["state.json"]);
});

it("skips syncing a directory only where the platform cannot sync one", async () => {
  syncs.fail.set(dir, "EINVAL");
  await writePrivateFile(file, "one");
  expect(await readFile(file, "utf8")).toBe("one");
});

// Once the rename replaced the file, readers and recovery see the new content: the write reports that it is installed, not that it failed.
it.each([["open", "failOpen"], ["sync", "fail"], ["close", "failClose"]] as const)("reports a write as installed when the directory %s fails after the rename", async (_at, faults) => {
  await writePrivateFile(file, "one");
  syncs[faults].set(dir, "EIO");
  const error = await writePrivateFile(file, "two").catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(InstalledWriteError);
  expect(error).toMatchObject({ cause: { code: "EIO" } });
  expect(await readFile(file, "utf8")).toBe("two");
  expect(await readdir(dir)).toEqual(["state.json"]);
});
