import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { processBirthSignature } from "@devfn/processes";

// Record which takeover markers a waiter reads; optionally fail the next
// link of a record aside.
const markerReads = vi.hoisted(() => [] as string[]);
const failures = vi.hoisted(() => ({ snapshotLink: undefined as NodeJS.ErrnoException | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      const failure = failures.snapshotLink;
      if (failure && String(args[1]).includes(".snapshot.")) { failures.snapshotLink = undefined; throw failure; }
      return await actual.link(...args);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]).includes(".takeover.")) markerReads.push(path.basename(String(args[0])));
      return await actual.readFile(...args);
    },
  };
});

const { withFileLock } = await import("../src/index.js");

let dir: string;
let lockPath: string;
beforeEach(async () => {
  markerReads.length = 0;
  failures.snapshotLink = undefined;
  dir = await mkdtemp(path.join(tmpdir(), "devfn-lock-takeover-"));
  lockPath = path.join(dir, "routing.lock");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const anHourAgo = () => new Date(Date.now() - 3_600_000).toISOString();
/** A PID whose process has exited and been reaped. */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

/** A lock recording a holder that has since died; returns the record's takeover marker prefix. */
async function deadHolderLock(): Promise<string> {
  await mkdir(lockPath);
  const record = JSON.stringify({ token: "dead", pid: deadPid(), createdAt: anHourAgo() });
  await writeFile(path.join(lockPath, "owner.json"), record);
  return `owner.takeover.${createHash("sha256").update(record).digest("hex").slice(0, 32)}.`;
}

/** Leave the marker of a taker of that record at a generation, as a taker killed after linking it would. */
async function killedTaker(prefix: string, generation: number): Promise<void> {
  await writeFile(path.join(lockPath, `${prefix}${generation}`), JSON.stringify({ token: `killed-${generation}`, pid: deadPid(), createdAt: anHourAgo() }));
}

const ownerRecord = async () => await readFile(path.join(lockPath, "owner.json"), "utf8");

it.each([15, 16, 17, 40])("recovers a dead holder's lock after %i takers of it were killed midway, and removes their markers", async (killed) => {
  const prefix = await deadHolderLock();
  for (let generation = 0; generation < killed; generation += 1) await killedTaker(prefix, generation);
  await expect(withFileLock(lockPath, async () => await readdir(lockPath), { staleMs: 1, timeoutMs: 10_000 })).resolves.toEqual(["owner.json"]);
  expect(await readdir(dir)).toEqual([]);
}, 20_000);

it.each([0, 20])("never takes a dead holder's lock over while a live taker holds its marker at generation %i", async (generation) => {
  const prefix = await deadHolderLock();
  for (let earlier = 0; earlier < generation; earlier += 1) await killedTaker(prefix, earlier);
  const live = JSON.stringify({ token: "live", pid: process.pid, birthSignature: await processBirthSignature(process.pid), createdAt: new Date().toISOString() });
  await writeFile(path.join(lockPath, `${prefix}${generation}`), live);
  const before = await ownerRecord();
  await expect(withFileLock(lockPath, async () => "taken", { staleMs: 1, timeoutMs: 500 })).rejects.toMatchObject({ code: "DEVFN_REGISTRY_LOCK_TIMEOUT" });
  // The waiter got as far as the live taker, and changed nothing.
  expect(markerReads).toContain(`${prefix}${generation}`);
  expect(await ownerRecord()).toBe(before);
  expect(await readFile(path.join(lockPath, `${prefix}${generation}`), "utf8")).toBe(live);
  expect((await readdir(lockPath)).sort()).toEqual(["owner.json", ...Array.from({ length: generation + 1 }, (_, index) => `${prefix}${index}`)].sort());
}, 20_000);

it.each([
  ["malformed", async (marker: string) => { await writeFile(marker, "{"); }],
  ["unreadable", async (marker: string) => { await writeFile(marker, "{}"); await chmod(marker, 0); }],
] as const)("treats a %s takeover marker as a possibly live taker", async (kind, write) => {
  if (kind === "unreadable" && process.getuid?.() === 0) return;
  const prefix = await deadHolderLock();
  await write(path.join(lockPath, `${prefix}0`));
  const before = await ownerRecord();
  await expect(withFileLock(lockPath, async () => "taken", { staleMs: 1, timeoutMs: 300 })).rejects.toMatchObject({ code: "DEVFN_REGISTRY_LOCK_TIMEOUT" });
  expect(await ownerRecord()).toBe(before);
});

it.each([
  ["before linking its marker", false, false],
  ["after linking its marker", true, false],
  ["after linking the record aside", true, true],
] as const)("recovers a dead holder's lock whose taker was killed %s", async (_, marked, snapshotted) => {
  const prefix = await deadHolderLock();
  const taker = JSON.stringify({ token: "killed", pid: deadPid(), createdAt: anHourAgo() });
  await writeFile(path.join(lockPath, "owner.killed.tmp"), taker);
  if (marked) await writeFile(path.join(lockPath, `${prefix}0`), taker);
  if (snapshotted) await writeFile(path.join(lockPath, "owner.snapshot.killed"), await ownerRecord());
  const entered = await withFileLock(lockPath, async () => JSON.parse(await ownerRecord()) as { token: string }, { staleMs: 1, timeoutMs: 5_000 });
  expect(entered.token).not.toMatch(/^(dead|killed)$/);
  expect(await readdir(dir)).toEqual([]);
});

it("recovers a lock whose taker was killed after replacing the dead record but before removing its markers", async () => {
  const prefix = await deadHolderLock();
  await killedTaker(prefix, 0);
  await writeFile(path.join(lockPath, "owner.snapshot.killed"), await ownerRecord());
  // The killed taker's own record replaced the dead one.
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ token: "killed", pid: deadPid(), createdAt: anHourAgo() }));
  const entered = await withFileLock(lockPath, async () => JSON.parse(await ownerRecord()) as { token: string }, { staleMs: 1, timeoutMs: 5_000 });
  expect(entered.token).not.toMatch(/^(dead|killed)$/);
  expect(await readdir(dir)).toEqual([]);
});

it("removes only its own marker when its takeover fails while the dead record is still current", async () => {
  const prefix = await deadHolderLock();
  for (let generation = 0; generation < 3; generation += 1) await killedTaker(prefix, generation);
  failures.snapshotLink = Object.assign(new Error("injected I/O failure"), { code: "EIO" });
  await expect(withFileLock(lockPath, async () => "taken", { staleMs: 1, timeoutMs: 1_000 })).rejects.toMatchObject({ code: "EIO" });
  // The dead takers' markers stay a gapless run behind the dead record.
  expect((await readdir(lockPath)).sort()).toEqual(["owner.json", `${prefix}0`, `${prefix}1`, `${prefix}2`].sort());
  await expect(withFileLock(lockPath, async () => await readdir(lockPath), { staleMs: 1, timeoutMs: 5_000 })).resolves.toEqual(["owner.json"]);
  expect(await readdir(dir)).toEqual([]);
});

it("removes a lock a holder released but was killed before deleting", async () => {
  const released = path.join(dir, "routing.lock.released.killed");
  await mkdir(released);
  await writeFile(path.join(released, "owner.json"), JSON.stringify({ token: "killed", pid: deadPid(), createdAt: anHourAgo() }));
  await writeFile(path.join(dir, "other.lock.released.unrelated"), "");
  await expect(withFileLock(lockPath, async () => "held")).resolves.toBe("held");
  expect(await readdir(dir)).toEqual(["other.lock.released.unrelated"]);
});
